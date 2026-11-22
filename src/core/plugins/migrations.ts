import type { D1Database, D1PreparedStatement } from '@cloudflare/workers-types';
import type { BurrowServerPlugin, PluginDialect, PluginMigration } from '@burrow/sdk';
import {
  assertPluginDialectSupported,
  pluginTablePrefix,
  validatePluginManifest,
} from './manifest';
import {
  assertPluginSqlAllowed,
  isD1Database,
  isPostgresClient,
  splitPluginSqlStatements,
  translateSqlToPostgres,
  type PostgresLikeSql,
} from './plugin-db';

interface SqliteLikeDb {
  prepare(sql: string): {
    run(...params: unknown[]): unknown;
    all(...params: unknown[]): unknown[];
  };
  exec?(sql: string): void;
  transaction?<T>(fn: () => T): () => T;
}

function unwrapDbClient(rawDb: unknown): D1Database | SqliteLikeDb | PostgresLikeSql | null {
  if (!rawDb || (typeof rawDb !== 'object' && typeof rawDb !== 'function')) return null;
  if (typeof rawDb === 'object' && rawDb !== null && '$client' in rawDb) {
    return (rawDb as { $client: D1Database | SqliteLikeDb | PostgresLikeSql }).$client;
  }
  return rawDb as D1Database | SqliteLikeDb | PostgresLikeSql;
}

const CREATE_LEDGER_SQL =
  'CREATE TABLE IF NOT EXISTS plugin_migrations (plugin_id TEXT NOT NULL, name TEXT NOT NULL, applied_at INTEGER NOT NULL, PRIMARY KEY (plugin_id, name))';

const CREATE_PG_LEDGER_SQL =
  'CREATE TABLE IF NOT EXISTS plugin_migrations (plugin_id TEXT NOT NULL, name TEXT NOT NULL, applied_at BIGINT NOT NULL, PRIMARY KEY (plugin_id, name))';

function selectMigrationsForDialect(
  plugin: BurrowServerPlugin,
  activeDialect: PluginDialect,
): PluginMigration[] {
  const all = plugin.migrations ?? [];
  const matching = all.filter((m) => !m.dialect || m.dialect === activeDialect);
  if (all.length > 0 && matching.length === 0) {
    throw new Error(
      `Plugin "${plugin.manifest.id}" has migrations, but none match active dialect "${activeDialect}"`,
    );
  }
  return matching;
}

function normalizePostgresMigrationDdl(sqlText: string): string {
  // Replace SQLite `INTEGER` timestamp/numeric columns with `BIGINT` in DDL when targeting Postgres
  let pg = translateSqlToPostgres(sqlText);
  pg = pg.replace(/\bINTEGER\b/gi, 'BIGINT');
  return pg;
}

/**
 * Idempotently applies plugin-owned migrations against D1, Node SQLite, or PostgreSQL.
 * Each migration is validated to only create/alter/drop `plugin_<id>_*` objects
 * and commits atomically alongside its ledger row.
 */
export async function runPluginMigrations(
  rawDb: unknown,
  plugins: ReadonlyArray<BurrowServerPlugin>,
): Promise<string[]> {
  const client = unwrapDbClient(rawDb);
  if (!client) return [];

  const activeDialect: PluginDialect = isPostgresClient(client) ? 'postgres' : 'sqlite';

  for (const plugin of plugins) {
    validatePluginManifest(plugin.manifest);
    assertPluginDialectSupported(plugin.manifest, activeDialect);
  }

  const withMigrations = plugins.filter((p) => (p.migrations?.length ?? 0) > 0);
  if (withMigrations.length === 0) return [];

  if (isPostgresClient(client)) {
    const newlyApplied: string[] = [];
    await client.begin(async (tx) => {
      await tx.unsafe("SELECT pg_advisory_xact_lock(hashtext('burrow:plugin_migrations'))");
      await tx.unsafe(CREATE_PG_LEDGER_SQL);

      const existingRows = await tx.unsafe('SELECT plugin_id, name FROM plugin_migrations');
      const applied = new Set(
        existingRows.map((r) => `${String(r.plugin_id)}:${String(r.name)}`),
      );

      for (const plugin of withMigrations) {
        const pluginId = plugin.manifest.id;
        const prefix = pluginTablePrefix(pluginId);
        const schemaName = `plugin_${pluginId.replace(/-/g, '_')}`;
        await tx.unsafe(`CREATE SCHEMA IF NOT EXISTS "${schemaName}"`);

        const seenNames = new Set<string>();
        const migrations = selectMigrationsForDialect(plugin, 'postgres');

        for (const migration of migrations) {
          if (!migration.name || seenNames.has(migration.name)) {
            throw new Error(
              `Plugin "${pluginId}" has duplicate or empty migration name "${migration.name}"`,
            );
          }
          seenNames.add(migration.name);

          const key = `${pluginId}:${migration.name}`;
          if (applied.has(key)) continue;

          assertPluginSqlAllowed(pluginId, migration.sql, prefix);
          const statements = splitPluginSqlStatements(migration.sql);
          for (const stmt of statements) {
            await tx.unsafe(normalizePostgresMigrationDdl(stmt));
          }

          await tx.unsafe(
            'INSERT INTO plugin_migrations (plugin_id, name, applied_at) VALUES ($1, $2, $3) ON CONFLICT (plugin_id, name) DO NOTHING',
            [pluginId, migration.name, Date.now()],
          );
          applied.add(key);
          newlyApplied.push(key);
        }
      }
    });
    return newlyApplied;
  }

  if (typeof (client as { prepare?: unknown }).prepare !== 'function') {
    return [];
  }

  if (isD1Database(client)) {
    await client.prepare(CREATE_LEDGER_SQL).run();
    const existingRes = await client
      .prepare('SELECT plugin_id, name FROM plugin_migrations')
      .all<{ plugin_id: string; name: string }>();
    const applied = new Set(
      (existingRes.results ?? []).map((row) => `${row.plugin_id}:${row.name}`),
    );

    const newlyApplied: string[] = [];
    for (const plugin of withMigrations) {
      const pluginId = plugin.manifest.id;
      const prefix = pluginTablePrefix(pluginId);
      const seenNames = new Set<string>();
      const migrations = selectMigrationsForDialect(plugin, 'sqlite');

      for (const migration of migrations) {
        if (!migration.name || seenNames.has(migration.name)) {
          throw new Error(
            `Plugin "${pluginId}" has duplicate or empty migration name "${migration.name}"`,
          );
        }
        seenNames.add(migration.name);

        const key = `${pluginId}:${migration.name}`;
        if (applied.has(key)) continue;

        assertPluginSqlAllowed(pluginId, migration.sql, prefix);
        const statements = splitPluginSqlStatements(migration.sql);
        const batch: D1PreparedStatement[] = [
          ...statements.map((stmt) => client.prepare(stmt)),
          client
            .prepare('INSERT OR IGNORE INTO plugin_migrations (plugin_id, name, applied_at) VALUES (?, ?, ?)')
            .bind(pluginId, migration.name, Date.now()),
        ];
        await client.batch(batch);
        applied.add(key);
        newlyApplied.push(key);
      }
    }
    return newlyApplied;
  }

  const sqlite = client as SqliteLikeDb;
  sqlite.prepare(CREATE_LEDGER_SQL).run();
  const rows = sqlite.prepare('SELECT plugin_id, name FROM plugin_migrations').all() as Array<{
    plugin_id: string;
    name: string;
  }>;
  const applied = new Set(rows.map((r) => `${r.plugin_id}:${r.name}`));
  const newlyApplied: string[] = [];

  for (const plugin of withMigrations) {
    const pluginId = plugin.manifest.id;
    const prefix = pluginTablePrefix(pluginId);
    const seenNames = new Set<string>();
    const migrations = selectMigrationsForDialect(plugin, 'sqlite');

    for (const migration of migrations) {
      if (!migration.name || seenNames.has(migration.name)) {
        throw new Error(
          `Plugin "${pluginId}" has duplicate or empty migration name "${migration.name}"`,
        );
      }
      seenNames.add(migration.name);

      const key = `${pluginId}:${migration.name}`;
      if (applied.has(key)) continue;

      assertPluginSqlAllowed(pluginId, migration.sql, prefix);
      const statements = splitPluginSqlStatements(migration.sql);
      const applyTx = () => {
        for (const stmt of statements) {
          sqlite.prepare(stmt).run();
        }
        sqlite
          .prepare('INSERT OR IGNORE INTO plugin_migrations (plugin_id, name, applied_at) VALUES (?, ?, ?)')
          .run(pluginId, migration.name, Date.now());
      };
      if (typeof sqlite.transaction === 'function') {
        sqlite.transaction(applyTx)();
      } else {
        applyTx();
      }
      applied.add(key);
      newlyApplied.push(key);
    }
  }
  return newlyApplied;
}

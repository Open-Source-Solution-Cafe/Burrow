import type { D1Database, D1PreparedStatement } from '@cloudflare/workers-types';
import type { BurrowServerPlugin } from '@burrow/sdk';
import { pluginTablePrefix, validatePluginManifest } from './manifest';
import { assertPluginSqlAllowed, splitPluginSqlStatements } from './plugin-db';

interface SqliteLikeDb {
  prepare(sql: string): {
    run(...params: unknown[]): unknown;
    all(...params: unknown[]): unknown[];
  };
  exec?(sql: string): void;
  transaction?<T>(fn: () => T): () => T;
}

function unwrapDbClient(rawDb: unknown): D1Database | SqliteLikeDb | null {
  if (!rawDb || typeof rawDb !== 'object') return null;
  if ('$client' in rawDb) {
    return (rawDb as { $client: D1Database | SqliteLikeDb }).$client;
  }
  return rawDb as D1Database | SqliteLikeDb;
}

function isD1Database(client: unknown): client is D1Database {
  return (
    typeof client === 'object' &&
    client !== null &&
    typeof (client as { batch?: unknown }).batch === 'function' &&
    typeof (client as { prepare?: unknown }).prepare === 'function'
  );
}

const CREATE_LEDGER_SQL =
  'CREATE TABLE IF NOT EXISTS plugin_migrations (plugin_id TEXT NOT NULL, name TEXT NOT NULL, applied_at INTEGER NOT NULL, PRIMARY KEY (plugin_id, name))';

/**
 * Idempotently applies plugin-owned migrations against D1 or Node SQLite.
 * Each migration is validated to only create/alter/drop `plugin_<id>_*` objects
 * and commits atomically alongside its ledger row inside `db.batch()`.
 */
export async function runPluginMigrations(
  rawDb: unknown,
  plugins: ReadonlyArray<BurrowServerPlugin>,
): Promise<string[]> {
  const client = unwrapDbClient(rawDb);
  if (!client || typeof (client as { prepare?: unknown }).prepare !== 'function') {
    return [];
  }

  const withMigrations = plugins.filter((p) => (p.migrations?.length ?? 0) > 0);
  if (withMigrations.length === 0) return [];

  for (const plugin of withMigrations) {
    validatePluginManifest(plugin.manifest);
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

      for (const migration of plugin.migrations ?? []) {
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

    for (const migration of plugin.migrations ?? []) {
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

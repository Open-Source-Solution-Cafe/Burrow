import { D1_MIGRATIONS } from './d1-migrations';
import type { Env } from './env';
import type { BurrowServerPlugin } from '@burrow/sdk';
import { runPluginMigrations } from '../core/plugins/migrations';

export type ResolvedWorkerBindings = Env['Bindings'] & {
  BETTER_AUTH_SECRET: string;
  BETTER_AUTH_URL: string;
  BOOTSTRAP_TOKEN: string;
};

const migratedDbs = new WeakMap<object, Promise<void>>();
const migratedPluginSets = new WeakMap<object, Map<string, Promise<void>>>();
const secretCache = new WeakMap<object, Promise<string>>();

/** Split a SQLite/D1 migration file into executable statements. */
export function splitD1MigrationStatements(sql: string): string[] {
  return sql
    .split('--> statement-breakpoint')
    .map((chunk) => chunk.trim())
    .filter((chunk) => {
      if (!chunk) return false;
      const withoutLineComments = chunk.replace(/^\s*--[^\n]*(?:\n|$)/gm, '').trim();
      return withoutLineComments.length > 0;
    });
}

function isLoopbackHost(hostname: string): boolean {
  return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '[::1]';
}

function tryParseUrl(value: string): URL | null {
  try {
    return new URL(value);
  } catch {
    return null;
  }
}

/** Safely derive BETTER_AUTH_URL from the request origin when omitted or localhost-only in Worker config. */
export function deriveWorkerAuthUrl(configuredUrl: string | undefined, requestUrl: string): string {
  const parsedRequest = tryParseUrl(requestUrl);

  const trimmed = configuredUrl?.trim();
  if (trimmed) {
    const parsedConfigured = tryParseUrl(trimmed);
    const isLocalPlaceholder = parsedConfigured ? isLoopbackHost(parsedConfigured.hostname) : false;

    // Ignore localhost placeholders left in config once serving real HTTPS Worker traffic.
    if (
      isLocalPlaceholder &&
      parsedRequest &&
      parsedRequest.protocol === 'https:' &&
      !isLoopbackHost(parsedRequest.hostname)
    ) {
      return parsedRequest.origin;
    }
    return trimmed;
  }

  if (
    parsedRequest &&
    (parsedRequest.protocol === 'https:' || isLoopbackHost(parsedRequest.hostname))
  ) {
    return parsedRequest.origin;
  }
  return '';
}

function generateHexSecret(bytesLength = 32): string {
  const bytes = new Uint8Array(bytesLength);
  crypto.getRandomValues(bytes);
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

async function listExistingTables(db: D1Database): Promise<Set<string>> {
  const res = await db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
    .all<{ name: string }>();
  return new Set((res.results ?? []).map((r) => r.name));
}

async function listTableColumns(db: D1Database, tableName: string): Promise<Set<string>> {
  const res = await db.prepare(`PRAGMA table_info('${tableName}')`).all<{ name: string }>();
  return new Set((res.results ?? []).map((r) => r.name));
}

async function ensureD1SchemaMigrated(db: D1Database): Promise<void> {
  await db
    .prepare(
      'CREATE TABLE IF NOT EXISTS d1_migrations (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT UNIQUE, applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP NOT NULL)',
    )
    .run();

  const tables = await listExistingTables(db);
  const appliedRes = await db.prepare('SELECT name FROM d1_migrations').all<{ name: string }>();
  const applied = new Set((appliedRes.results ?? []).map((r) => r.name));

  // Fast path: all known migrations already recorded and core table exists.
  if (tables.has('workspaces') && D1_MIGRATIONS.every((m) => applied.has(m.name))) {
    return;
  }

  let workspaceCols = tables.has('workspaces')
    ? await listTableColumns(db, 'workspaces')
    : new Set<string>();
  let publicShareCols = tables.has('public_shares')
    ? await listTableColumns(db, 'public_shares')
    : new Set<string>();

  for (const migration of D1_MIGRATIONS) {
    if (applied.has(migration.name)) continue;

    // Skip already-present schema objects on pre-existing databases and backfill ledger.
    let alreadyPresent = false;
    if (migration.name === '0000_baseline.sql' && tables.has('workspaces')) {
      alreadyPresent = true;
    } else if (migration.name === '0001_rate_limits_and_cleanup.sql' && tables.has('rate_limits')) {
      alreadyPresent = true;
    } else if (
      migration.name === '0003_add_workspace_feature_flags.sql' &&
      workspaceCols.has('feature_flags')
    ) {
      alreadyPresent = true;
    } else if (migration.name === '0004_add_public_shares.sql' && tables.has('public_shares')) {
      alreadyPresent = true;
    } else if (
      migration.name === '0005_add_public_share_enabled.sql' &&
      publicShareCols.has('enabled')
    ) {
      alreadyPresent = true;
    }

    if (alreadyPresent) {
      await db
        .prepare('INSERT OR IGNORE INTO d1_migrations (name) VALUES (?)')
        .bind(migration.name)
        .run();
      applied.add(migration.name);
      continue;
    }

    const statements = splitD1MigrationStatements(migration.sql);
    const batch = [
      ...statements.map((stmt) => db.prepare(stmt)),
      db.prepare('INSERT OR IGNORE INTO d1_migrations (name) VALUES (?)').bind(migration.name),
    ];
    await db.batch(batch);
    applied.add(migration.name);

    if (migration.name === '0000_baseline.sql') {
      tables.add('workspaces');
      workspaceCols = await listTableColumns(db, 'workspaces');
    } else if (migration.name === '0004_add_public_shares.sql') {
      tables.add('public_shares');
      publicShareCols = await listTableColumns(db, 'public_shares');
    }
  }
}

async function getOrCreatePersistedAuthSecret(db: D1Database): Promise<string> {
  await db
    .prepare(
      'CREATE TABLE IF NOT EXISTS _worker_runtime_config (key TEXT PRIMARY KEY NOT NULL, value TEXT NOT NULL, created_at INTEGER NOT NULL)',
    )
    .run();

  const existing = await db
    .prepare("SELECT value FROM _worker_runtime_config WHERE key = 'better_auth_secret'")
    .first<{ value: string }>();
  if (existing?.value && existing.value.length >= 32) {
    return existing.value;
  }

  const candidate = generateHexSecret(32);
  await db
    .prepare(
      "INSERT OR IGNORE INTO _worker_runtime_config (key, value, created_at) VALUES ('better_auth_secret', ?, ?)",
    )
    .bind(candidate, Date.now())
    .run();

  const persisted = await db
    .prepare("SELECT value FROM _worker_runtime_config WHERE key = 'better_auth_secret'")
    .first<{ value: string }>();
  if (!persisted?.value || persisted.value.length < 32) {
    throw new Error('Failed to initialize persisted BETTER_AUTH_SECRET in D1');
  }
  return persisted.value;
}

/**
 * Ensures first-boot D1 schema initialization, dynamic BETTER_AUTH_URL derivation,
 * and D1-persisted BETTER_AUTH_SECRET fallback so one-click Cloudflare deploys boot cleanly.
 */
export async function ensureWorkerRuntimeEnv(
  env: Env['Bindings'],
  request: Request,
  plugins: ReadonlyArray<BurrowServerPlugin> = [],
): Promise<ResolvedWorkerBindings> {
  const dbKey = env.DB as unknown as object;

  let migrationPromise = migratedDbs.get(dbKey);
  if (!migrationPromise) {
    migrationPromise = ensureD1SchemaMigrated(env.DB).catch((err) => {
      migratedDbs.delete(dbKey);
      throw err;
    });
    migratedDbs.set(dbKey, migrationPromise);
  }
  await migrationPromise;

  if (plugins.some((p) => (p.migrations?.length ?? 0) > 0)) {
    const pluginKey = plugins
      .map((p) => `${p.manifest.id}@${p.manifest.version}:${(p.migrations ?? []).map((m) => m.name).join(',')}`)
      .join('|');
    let perDbMap = migratedPluginSets.get(dbKey);
    if (!perDbMap) {
      perDbMap = new Map();
      migratedPluginSets.set(dbKey, perDbMap);
    }
    let pluginMigrationPromise = perDbMap.get(pluginKey);
    if (!pluginMigrationPromise) {
      pluginMigrationPromise = runPluginMigrations(env.DB, plugins)
        .then(() => undefined)
        .catch((err) => {
          perDbMap!.delete(pluginKey);
          throw err;
        });
      perDbMap.set(pluginKey, pluginMigrationPromise);
    }
    await pluginMigrationPromise;
  }

  const configuredSecret = env.BETTER_AUTH_SECRET?.trim() ?? '';
  let resolvedSecret = configuredSecret;
  if (configuredSecret.length < 32) {
    let secretPromise = secretCache.get(dbKey);
    if (!secretPromise) {
      secretPromise = getOrCreatePersistedAuthSecret(env.DB).catch((err) => {
        secretCache.delete(dbKey);
        throw err;
      });
      secretCache.set(dbKey, secretPromise);
    }
    resolvedSecret = await secretPromise;
  }

  const resolvedUrl = deriveWorkerAuthUrl(env.BETTER_AUTH_URL, request.url);

  return {
    ...env,
    BETTER_AUTH_SECRET: resolvedSecret,
    BETTER_AUTH_URL: resolvedUrl,
    BOOTSTRAP_TOKEN: env.BOOTSTRAP_TOKEN?.trim() ?? '',
  };
}

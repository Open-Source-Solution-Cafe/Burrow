import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadEnv as canonicalLoadEnv } from '../src/server/env.ts';
import { parseCliArgs, selectDatabaseTarget } from '../src/server/database-target.ts';
import { splitSqlStatements } from '../src/server/sql-statements.ts';

export { parseCliArgs };
export const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export const KNOWN_SECRET_PLACEHOLDERS = new Set([
  'dev-secret-change-me-32-bytes-minimum!!',
  'local-dev-secret-change-me',
  'burrow-selfhost-secret-key-32-bytes-minimum!!',
]);

export const KNOWN_BOOTSTRAP_PLACEHOLDERS = new Set([
  'dev-bootstrap-token',
  'test-bootstrap-token',
  'burrow-bootstrap-token-initial-setup',
]);

/**
 * Resolves the bootstrap token for local development, setup, and click-through tests.
 * Never uses hardcoded or predictable default tokens ('dev-bootstrap-token', 'test-bootstrap-token').
 * If a custom token (>= 16 characters) is not explicitly provided, generates a unique,
 * cryptographically secure 32-character hex token.
 */
export function getBootstrapToken(env = process.env) {
  const token = env.BOOTSTRAP_TOKEN?.trim();
  return token && !KNOWN_BOOTSTRAP_PLACEHOLDERS.has(token) && token.length >= 16
    ? token
    : crypto.randomBytes(16).toString('hex');
}

/** Resolve a dependency's executable path without relying on PATH/shell shims. */
export function bin(pkg, sub) {
  const pkgPath = path.join(root, 'node_modules', pkg, 'package.json');
  const pkgJson = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
  const b = pkgJson.bin;
  if (typeof b === 'string') return path.join(root, 'node_modules', pkg, b);
  const preferred = sub ?? path.basename(pkg);
  const key = b[preferred] ? preferred : Object.keys(b)[0];
  return path.join(root, 'node_modules', pkg, b[key]);
}

export function normalizeDomain(rawDomain) {
  if (!rawDomain) return undefined;
  let cleaned = String(rawDomain).trim();
  // Strip protocol if provided (e.g. https:// or http://)
  cleaned = cleaned.replace(/^https?:\/\//i, '');
  // Strip trailing path/query/fragment (e.g. / or /api/...)
  cleaned = cleaned.replace(/\/.*$/, '').replace(/[?#].*$/, '');
  // Strip trailing slashes or whitespace
  cleaned = cleaned.replace(/\/+$/, '').trim();
  if (cleaned && cleaned !== rawDomain) {
    console.log(`  normalized domain: "${rawDomain}" -> "${cleaned}"`);
  }
  return cleaned || undefined;
}

function _argValueFrom(args, flag, fallback = undefined) {
  const parsed = parseCliArgs(args);
  return parsed.values[flag] ?? fallback;
}

function _hasFlagIn(args, flag) {
  const parsed = parseCliArgs(args);
  return parsed.booleanFlags[flag] === true;
}

export function argValue(flag, fallback = undefined) {
  return _argValueFrom(process.argv.slice(2), flag, fallback);
}

export function hasFlag(flag) {
  return _hasFlagIn(process.argv.slice(2), flag);
}

function readBaseWranglerConfig() {
  const configPath = path.join(root, 'wrangler.jsonc');
  if (!fs.existsSync(configPath)) return {};
  return parseJsonc(fs.readFileSync(configPath, 'utf8'));
}

export function resolveEnvironmentName(args = [], env = process.env) {
  const parsed = parseCliArgs(args);
  const cliEnvRaw = parsed.values['--env'];
  if (
    cliEnvRaw !== undefined &&
    cliEnvRaw !== 'production' &&
    cliEnvRaw !== 'staging' &&
    cliEnvRaw !== 'demo'
  ) {
    throw new Error(
      `Invalid --env value "${cliEnvRaw}". Expected "production", "staging", or "demo".`,
    );
  }

  const envVarRaw = env.BURROW_DEPLOY_ENV?.trim();
  if (
    envVarRaw &&
    envVarRaw !== 'production' &&
    envVarRaw !== 'staging' &&
    envVarRaw !== 'demo'
  ) {
    throw new Error(
      `Invalid BURROW_DEPLOY_ENV value "${envVarRaw}". Expected "production", "staging", or "demo".`,
    );
  }

  if (parsed.booleanFlags['--demo'] === true || cliEnvRaw === 'demo') {
    return 'demo';
  }
  if (parsed.booleanFlags['--staging'] === true || cliEnvRaw === 'staging') {
    return 'staging';
  }
  if (
    parsed.booleanFlags['--staging'] === false ||
    parsed.booleanFlags['--demo'] === false ||
    cliEnvRaw === 'production'
  ) {
    return 'production';
  }
  if (envVarRaw === 'demo') {
    return 'demo';
  }
  if (envVarRaw === 'staging') {
    return 'staging';
  }
  return 'production';
}

export function assertEnvironmentTargetIsolation(profile, env = process.env) {
  const prodDomain = normalizeDomain(env.CLOUDFLARE_DOMAIN);
  const { isStaging, isDemo, workerName, dbName, bucketName, domain, envD1Id } = profile;

  if (isStaging) {
    if (workerName === 'burrow' || !/staging/i.test(workerName) || /\bdemo\b|-demo\b/i.test(workerName)) {
      throw new Error(
        `Refusing staging profile with production or unscoped Worker name "${workerName}". Staging Worker names must include "staging".`,
      );
    }
    if (dbName === 'burrow' || !/staging/i.test(dbName) || /\bdemo\b|-demo\b/i.test(dbName)) {
      throw new Error(
        `Refusing staging profile with production or unscoped D1 database "${dbName}". Staging D1 names must include "staging".`,
      );
    }
    if (
      bucketName &&
      (bucketName === 'burrow-files' || !/staging/i.test(bucketName) || /\bdemo\b|-demo\b/i.test(bucketName))
    ) {
      throw new Error(
        `Refusing staging profile with production or unscoped R2 bucket "${bucketName}". Staging bucket names must include "staging".`,
      );
    }
    if (domain && (domain === prodDomain || domain === 'burrow.osscafe.com' || !/staging/i.test(domain))) {
      throw new Error(
        `Refusing to attach production domain "${domain}" to staging Worker "${workerName}".`,
      );
    }
  } else if (isDemo) {
    if (
      workerName === 'burrow' ||
      /\bstaging\b|-staging\b/i.test(workerName) ||
      !/demo/i.test(workerName)
    ) {
      throw new Error(
        `Refusing demo profile with production, staging, or non-demo Worker name "${workerName}". Demo Worker names must be distinct and include "demo".`,
      );
    }
    if (dbName === 'burrow' || /\bstaging\b|-staging\b/i.test(dbName) || !/demo/i.test(dbName)) {
      throw new Error(
        `Refusing demo profile with production, staging, or non-demo D1 database "${dbName}". Demo D1 names must be distinct and include "demo".`,
      );
    }
    if (
      bucketName &&
      (bucketName === 'burrow-files' ||
        /\bstaging\b|-staging\b/i.test(bucketName) ||
        !/demo/i.test(bucketName))
    ) {
      throw new Error(
        `Refusing demo profile with production, staging, or non-demo R2 bucket "${bucketName}". Demo bucket names must be distinct and include "demo".`,
      );
    }
    if (
      domain &&
      ((prodDomain && domain === prodDomain) || /(^|\.)staging(\.|$)|-staging\b/i.test(domain))
    ) {
      throw new Error(
        `Refusing to attach conflicting domain "${domain}" to demo Worker "${workerName}".`,
      );
    }
    const prodD1Id = (env.D1_DATABASE_ID || env.CLOUDFLARE_D1_DATABASE_ID)?.trim();
    const stagingD1Id = env.STAGING_D1_DATABASE_ID?.trim();
    if (envD1Id && prodD1Id && envD1Id.toLowerCase() === prodD1Id.toLowerCase()) {
      throw new Error(
        `Refusing demo profile whose DEMO_D1_DATABASE_ID matches production D1_DATABASE_ID (${envD1Id}).`,
      );
    }
    if (envD1Id && stagingD1Id && envD1Id.toLowerCase() === stagingD1Id.toLowerCase()) {
      throw new Error(
        `Refusing demo profile whose DEMO_D1_DATABASE_ID matches STAGING_D1_DATABASE_ID (${envD1Id}).`,
      );
    }
  } else {
    if (/-staging\b/i.test(workerName) || /\bstaging\b/i.test(workerName)) {
      throw new Error(`Refusing production profile with staging Worker name "${workerName}".`);
    }
    if (/-demo\b/i.test(workerName) || /\bdemo\b/i.test(workerName)) {
      throw new Error(`Refusing production profile with demo Worker name "${workerName}".`);
    }
    if (/-staging\b/i.test(dbName) || /\bstaging\b/i.test(dbName)) {
      throw new Error(`Refusing production profile with staging D1 database "${dbName}".`);
    }
    if (/-demo\b/i.test(dbName) || /\bdemo\b/i.test(dbName)) {
      throw new Error(`Refusing production profile with demo D1 database "${dbName}".`);
    }
    if (bucketName && (/-staging\b/i.test(bucketName) || /\bstaging\b/i.test(bucketName))) {
      throw new Error(`Refusing production profile with staging R2 bucket "${bucketName}".`);
    }
    if (bucketName && (/-demo\b/i.test(bucketName) || /\bdemo\b/i.test(bucketName))) {
      throw new Error(`Refusing production profile with demo R2 bucket "${bucketName}".`);
    }
    if (domain && /(^|\.)staging(\.|$)|-staging\b/i.test(domain)) {
      throw new Error(`Refusing production profile with staging domain "${domain}".`);
    }
  }
}

/**
 * Resolve isolated production, staging, or demo Cloudflare resource names, domain, and local config file.
 */
export function resolveRemoteProfile(
  baseConfig = readBaseWranglerConfig(),
  { args = process.argv.slice(2), env = process.env } = {},
) {
  const parsed = parseCliArgs(args);
  const envName = resolveEnvironmentName(args, env);
  const isStaging = envName === 'staging';
  const isDemo = envName === 'demo';

  const explicitName = parsed.values['--name'];
  const explicitDomain = parsed.values['--domain'] || parsed.values['--domains'];
  const hasWorkersDevFlag = parsed.booleanFlags['--workers-dev'] === true;

  const baseWorkerName = baseConfig?.name || 'burrow';
  const baseDbName = baseConfig?.d1_databases?.[0]?.database_name || 'burrow';
  const baseBucketName = baseConfig?.r2_buckets?.[0]?.bucket_name || null;

  let workerName;
  let dbName;
  let bucketName;
  let localConfigFilename;
  let d1EnvKey;
  let envD1Id;
  let domain;
  let expectedAccountId = null;

  if (isStaging) {
    workerName = explicitName || `${baseWorkerName}-staging`;
    dbName = `${baseDbName}-staging`;
    bucketName =
      baseBucketName && baseBucketName !== 'burrow-files'
        ? `${baseBucketName}-staging`
        : 'burrow-staging-files';
    localConfigFilename = 'wrangler.staging.local.jsonc';
    d1EnvKey = 'STAGING_D1_DATABASE_ID';
    envD1Id = env.STAGING_D1_DATABASE_ID?.trim() || null;
    domain = hasWorkersDevFlag
      ? undefined
      : normalizeDomain(explicitDomain || env.STAGING_CLOUDFLARE_DOMAIN);
  } else if (isDemo) {
    const demoSection = baseConfig?.env?.demo;
    const demoDefaultWorker = demoSection?.name || 'burrow-demo';
    const demoDefaultDb = demoSection?.d1_databases?.[0]?.database_name || 'burrow-demo';
    const demoDefaultBucket = demoSection?.r2_buckets?.[0]?.bucket_name || 'burrow-demo-files';
    workerName = explicitName || env.DEMO_WORKER_NAME?.trim() || demoDefaultWorker;
    dbName = env.DEMO_D1_DATABASE_NAME?.trim() || demoDefaultDb;
    bucketName = env.DEMO_R2_BUCKET_NAME?.trim() || demoDefaultBucket;
    localConfigFilename = 'wrangler.demo.local.jsonc';
    d1EnvKey = 'DEMO_D1_DATABASE_ID';
    envD1Id = env.DEMO_D1_DATABASE_ID?.trim() || null;
    expectedAccountId = env.DEMO_CLOUDFLARE_ACCOUNT_ID?.trim() || null;
    domain = hasWorkersDevFlag
      ? undefined
      : normalizeDomain(explicitDomain || env.DEMO_CLOUDFLARE_DOMAIN);
  } else {
    workerName = explicitName || baseWorkerName;
    dbName = baseDbName;
    bucketName = baseBucketName || 'burrow-files';
    localConfigFilename = 'wrangler.local.jsonc';
    d1EnvKey = 'D1_DATABASE_ID';
    envD1Id = (env.D1_DATABASE_ID || env.CLOUDFLARE_D1_DATABASE_ID)?.trim() || null;
    domain = hasWorkersDevFlag
      ? undefined
      : normalizeDomain(explicitDomain || env.CLOUDFLARE_DOMAIN);
  }

  const effectiveConfig = JSON.parse(
    JSON.stringify(baseConfig && typeof baseConfig === 'object' ? baseConfig : {}),
  );
  delete effectiveConfig.env;
  effectiveConfig.name = workerName;
  if (Array.isArray(effectiveConfig.d1_databases) && effectiveConfig.d1_databases[0]) {
    effectiveConfig.d1_databases[0].database_name = dbName;
  }
  if (Array.isArray(effectiveConfig.r2_buckets) && effectiveConfig.r2_buckets[0]) {
    effectiveConfig.r2_buckets[0].bucket_name = bucketName;
  }

  const profile = {
    isStaging,
    isDemo,
    envName,
    workerName,
    dbName,
    bucketName,
    localConfigFilename,
    d1EnvKey,
    envD1Id,
    expectedAccountId,
    domain,
    effectiveConfig,
  };

  assertEnvironmentTargetIsolation(profile, env);
  return profile;
}

export const resolveDeployProfile = resolveRemoteProfile;

/**
 * Fail-closed authorization guard for remote destructive operations (reset, teardown).
 * Never treats CI=true or --force alone as authorization to mutate production.
 */
export function assertProductionOperationAllowed({
  operation,
  profile,
  args = process.argv.slice(2),
  env = process.env,
  isInteractive = Boolean(process.stdin.isTTY),
}) {
  if (profile?.isStaging) {
    return { mode: 'staging' };
  }
  if (profile?.isDemo) {
    const parsedDemo = parseCliArgs(args);
    const confirmDemo =
      parsedDemo.values['--confirm-demo-reset'] || env.BURROW_DEMO_RESET_CONFIRM?.trim();
    if (env.BURROW_ALLOW_DEMO_RESET === 'true' && confirmDemo === 'RESET-DEMO-BURROW') {
      return { mode: 'demo-explicit' };
    }
    if (isInteractive && env.BURROW_ALLOW_DEMO_RESET === 'true') {
      return { mode: 'demo-interactive' };
    }
    throw new Error(
      `Refusing remote ${operation} on demo target "${profile.dbName}" without explicit demo authorization.`,
    );
  }
  if (!profile) {
    return { mode: 'staging' };
  }

  const parsed = parseCliArgs(args);
  const force = parsed.booleanFlags['--force'] === true;
  const confirmTarget = parsed.values['--confirm'];

  if (operation === 'reset') {
    const confirmReset = parsed.values['--confirm-production-reset'];
    if (confirmReset === 'RESET-PRODUCTION-BURROW' && confirmTarget === profile.workerName) {
      return { mode: 'explicit-flags' };
    }
    if (force || env.CI || !isInteractive) {
      throw new Error(
        `Refusing --force reset on PRODUCTION ("${profile.dbName}"). Destructive test resets must target staging (--staging). To reset production non-interactively, pass BOTH --confirm-production-reset=RESET-PRODUCTION-BURROW and --confirm=${profile.workerName}.`,
      );
    }
    return { mode: 'interactive' };
  }

  if (operation === 'teardown') {
    const confirmTeardown = parsed.values['--confirm-production-teardown'];
    if (confirmTeardown === 'DELETE-PRODUCTION-BURROW' && confirmTarget === profile.workerName) {
      return { mode: 'explicit-flags' };
    }
    if (force || env.CI || !isInteractive) {
      throw new Error(
        `Refusing --force teardown on PRODUCTION ("${profile.workerName}"). Destructive test teardowns must target staging (--staging). To tear down production non-interactively, pass BOTH --confirm-production-teardown=DELETE-PRODUCTION-BURROW and --confirm=${profile.workerName}.`,
      );
    }
    return { mode: 'interactive' };
  }

  throw new Error(`Unsupported destructive operation: ${operation}`);
}

/**
 * Fail-closed authorization guard for remote demo resets.
 * Enforces an explicit demo target (--demo / --env=demo) or explicit --confirm=<worker-name>,
 * explicit BURROW_ALLOW_DEMO_RESET=true, and explicit RESET-DEMO-BURROW confirmation.
 * Never treats CI=true or --force as authorization.
 */
export function assertDemoResetAllowed({
  profile,
  args = process.argv.slice(2),
  env = process.env,
  isInteractive = Boolean(process.stdin.isTTY),
}) {
  const parsed = parseCliArgs(args);
  const confirmTarget = parsed.values['--confirm'];
  const isConfirmedWorkerTarget =
    Boolean(profile?.workerName) && confirmTarget === profile.workerName;

  if (!profile || (!profile.isDemo && !isConfirmedWorkerTarget)) {
    throw new Error(
      `Refusing remote demo reset on non-demo target "${profile?.envName ?? 'unknown'}" ("${profile?.dbName ?? 'unknown'}"). Pass --demo targeting an isolated demo deployment or --confirm=${profile?.workerName ?? '<worker-name>'}; ordinary production and staging deployments cannot be reset by demo-reset.`,
    );
  }

  const demoAllowed = env.BURROW_ALLOW_DEMO_RESET === 'true';
  const confirmDemo =
    parsed.values['--confirm-demo-reset'] || env.BURROW_DEMO_RESET_CONFIRM?.trim();

  if (demoAllowed && confirmDemo === 'RESET-DEMO-BURROW') {
    return { mode: 'explicit-demo' };
  }

  if (!demoAllowed || env.CI || !isInteractive) {
    throw new Error(
      `Refusing remote demo reset on demo database "${profile.dbName}". Set BURROW_ALLOW_DEMO_RESET=true and pass --confirm-demo-reset=RESET-DEMO-BURROW (CI=true and --force alone never authorize resets).`,
    );
  }

  return { mode: 'interactive-demo' };
}

/** Update or append a KEY=VALUE entry inside an .env file without touching unrelated keys. */
export function upsertEnvVar(envPath, key, value) {
  if (!fs.existsSync(envPath)) return false;
  const rawEnv = fs.readFileSync(envPath, 'utf8');
  const nextVal = value ?? '';
  const pattern = new RegExp(`^${key}=.*$`, 'm');
  let updatedEnv;
  if (pattern.test(rawEnv)) {
    updatedEnv = rawEnv.replace(pattern, `${key}=${nextVal}`);
  } else if (nextVal) {
    const sep = rawEnv.length === 0 || rawEnv.endsWith('\n') ? '' : '\n';
    updatedEnv = `${rawEnv}${sep}${key}=${nextVal}\n`;
  } else {
    return false;
  }
  if (updatedEnv !== rawEnv) {
    fs.writeFileSync(envPath, updatedEnv, 'utf8');
    return true;
  }
  return false;
}

/** Check if the command was invoked with any remote flag: --remote, --r, or -r. */
export function isRemoteTarget() {
  return selectDatabaseTarget(process.argv.slice(2), {}, root).kind === 'remote';
}

export function getDatabaseTarget() {
  loadEnv();
  return selectDatabaseTarget(process.argv.slice(2), process.env, root);
}

function d1TargetArgs(target) {
  return target.kind === 'remote'
    ? [
        ...getWranglerConfigArgs({ required: true, purpose: 'remote database operation' }),
        '--remote',
      ]
    : ['--local', '--persist-to', target.persistTo];
}

const LEGACY_D1_DROP_TABLES_SQL = [
  'DROP TABLE IF EXISTS notepads_fts;',
  'DROP TABLE IF EXISTS pending_storage_deletions;',
  'DROP TABLE IF EXISTS rate_limits;',
  'DROP TABLE IF EXISTS project_files;',
  'DROP TABLE IF EXISTS card_subtasks;',
  'DROP TABLE IF EXISTS card_comments;',
  'DROP TABLE IF EXISTS card_assignees;',
  'DROP TABLE IF EXISTS cards;',
  'DROP TABLE IF EXISTS board_columns;',
  'DROP TABLE IF EXISTS boards;',
  'DROP TABLE IF EXISTS notepad_tags;',
  'DROP TABLE IF EXISTS notepad_links;',
  'DROP TABLE IF EXISTS edit_locks;',
  'DROP TABLE IF EXISTS notifications;',
  'DROP TABLE IF EXISTS notepads;',
  'DROP TABLE IF EXISTS tags;',
  'DROP TABLE IF EXISTS invites;',
  'DROP TABLE IF EXISTS members;',
  'DROP TABLE IF EXISTS projects;',
  'DROP TABLE IF EXISTS bootstrap_state;',
  'DROP TABLE IF EXISTS workspaces;',
  'DROP TABLE IF EXISTS session;',
  'DROP TABLE IF EXISTS account;',
  'DROP TABLE IF EXISTS verification;',
  'DROP TABLE IF EXISTS "user";',
  'DELETE FROM d1_migrations;',
];

function resetLegacyPreBaselineD1IfNeeded(
  databaseName,
  targetArgs,
  { allowPreBaselineReset = false, runFn = run } = {},
) {
  const check = runFn(
    bin('wrangler'),
    [
      'd1',
      'execute',
      databaseName,
      ...targetArgs,
      "--command=SELECT name FROM d1_migrations; SELECT name FROM sqlite_master WHERE type = 'trigger';",
      '--json',
    ],
    { capture: true, allowFail: true, quiet: true },
  );
  if (check.status !== 0) return;

  const parsed = parseFirstJson(check.stdout);
  const resultSets = Array.isArray(parsed) ? parsed : [parsed];
  const migrationRows = resultSets[0]?.results ?? resultSets[0]?.rows ?? [];
  if (!Array.isArray(migrationRows) || migrationRows.length === 0) return;

  const appliedNames = new Set(migrationRows.map((r) => r?.name).filter(Boolean));
  if (appliedNames.has('0000_baseline.sql')) return;

  if (!allowPreBaselineReset) {
    throw new Error(
      [
        `Detected legacy pre-baseline D1 migration ledger on "${databaseName}" (missing "0000_baseline.sql").`,
        'Automatic table deletion is disabled during setup/deploy to protect existing workspace data.',
        'Take a D1 backup/export (`wrangler d1 export burrow --remote --output backup.sql`), then either:',
        '  1. Follow docs/BOOTSTRAP_RECOVERY.md to migrate safely, or',
        '  2. Run `pnpm run reset -r` explicitly if you intend to wipe and re-initialize the database.',
      ].join('\n'),
    );
  }

  const triggerRows = resultSets[1]?.results ?? resultSets[1]?.rows ?? [];
  const dropTriggersSql = (Array.isArray(triggerRows) ? triggerRows : [])
    .map((r) => r?.name)
    .filter((name) => typeof name === 'string' && /^[A-Za-z0-9_]+$/.test(name))
    .map((name) => `DROP TRIGGER IF EXISTS "${name}";`);

  console.log(
    '  💡 Detected legacy pre-baseline D1 schema; dropping pre-baseline tables to apply 0000_baseline.sql cleanly...',
  );
  const dropSql = ['PRAGMA foreign_keys = OFF;', ...dropTriggersSql, ...LEGACY_D1_DROP_TABLES_SQL, 'PRAGMA foreign_keys = ON;'].join(' ');
  runFn(
    bin('wrangler'),
    ['d1', 'execute', databaseName, ...targetArgs, `--command=${dropSql}`],
    { allowFail: false },
  );
}

export async function migrateDatabase(
  target,
  { dryRun = false, configArgs, databaseName = 'burrow', allowPreBaselineReset = false, runFn = run } = {},
) {
  if (target.kind === 'node') {
    if (dryRun) {
      console.log(`  [dry-run] Migrate SQLite ${target.sqlitePath}`);
      return;
    }
    const { openSqliteDatabase } = await import('../src/server/sqlite.ts');
    openSqliteDatabase(target.sqlitePath, path.join(root, 'migrations')).close();
    return;
  }
  const targetArgs =
    target.kind === 'remote' && configArgs ? [...configArgs, '--remote'] : d1TargetArgs(target);
  if (!dryRun) {
    resetLegacyPreBaselineD1IfNeeded(databaseName, targetArgs, { allowPreBaselineReset, runFn });
  }
  runFn(bin('wrangler'), ['d1', 'migrations', 'apply', databaseName, ...targetArgs], {
    dryRun,
    env: { CI: '1' },
  });
}

/** Execute the canonical SQL file on the selected DB; invariant queries are semicolon-delimited. */
export async function executeDatabaseFile(
  target,
  sqlFile,
  { readOnly = false, databaseName, configArgs } = {},
) {
  if (target.kind === 'postgres') {
    if (!readOnly) throw new Error('PostgreSQL SQL-file execution is read-only');
    const postgres = (await import('postgres')).default;
    const client = postgres(target.url, { max: 1, connect_timeout: 10, onnotice: () => {} });
    try {
      const statements = splitSqlStatements(fs.readFileSync(sqlFile, 'utf8'));
      return await client.begin(async (transaction) => {
        await transaction.unsafe('SET TRANSACTION READ ONLY');
        const resultSets = [];
        for (const statement of statements) {
          resultSets.push({ results: await transaction.unsafe(statement) });
        }
        return resultSets;
      });
    } finally {
      await client.end();
    }
  }
  if (target.kind === 'node') {
    const { default: Database } = await import('better-sqlite3');
    const sqlite = new Database(target.sqlitePath, { readonly: readOnly, fileMustExist: true });
    try {
      const source = fs.readFileSync(sqlFile, 'utf8');
      if (readOnly) {
        return splitSqlStatements(source).map((statement) => ({
          results: sqlite.prepare(statement).all(),
        }));
      }
      sqlite.pragma('foreign_keys = ON');
      sqlite.transaction(() => sqlite.exec(source))();
      return [];
    } finally {
      sqlite.close();
    }
  }
  loadEnv();
  const profile = resolveRemoteProfile();
  const dbName = databaseName || (target.kind === 'remote' ? profile.dbName : 'burrow');
  const resolvedConfigArgs =
    configArgs ||
    (target.kind === 'remote'
      ? [
          ...getWranglerConfigArgs({ required: true, purpose: 'remote database operation', profile }),
          '--remote',
        ]
      : d1TargetArgs(target));
  const res = run(
    bin('wrangler'),
    ['d1', 'execute', dbName, ...resolvedConfigArgs, '--file', sqlFile, '--json'],
    { capture: true, quiet: true },
  );
  const parsed = parseFirstJson(res.stdout);
  if (parsed === null) throw new Error('Could not parse d1 execute output');
  return Array.isArray(parsed) ? parsed : [parsed];
}

/** Print a loud, prominent target banner at the start of a command. */
export function printTargetBanner(action, isRemote, { profile } = {}) {
  const staging = profile?.isStaging ?? hasFlag('--staging');
  const demo = profile?.isDemo ?? hasFlag('--demo');
  const remoteLabel = staging
    ? `🧪 REMOTE STAGING (Cloudflare: ${profile?.workerName || 'burrow-staging'})`
    : demo
      ? `🎭 REMOTE DEMO (Cloudflare: ${profile?.workerName || 'burrow-demo'})`
      : '☁️  REMOTE (Cloudflare Production)';
  const target =
    typeof isRemote === 'object'
      ? isRemote.kind === 'node'
        ? `💻 LOCAL SQLite (${isRemote.sqlitePath})`
        : isRemote.kind === 'worker'
          ? `💻 LOCAL Worker/D1 (${isRemote.persistTo})`
          : isRemote.kind === 'postgres'
            ? `PostgreSQL (${new URL(isRemote.url).host}${new URL(isRemote.url).pathname})`
            : remoteLabel
      : isRemote
        ? remoteLabel
        : '💻 LOCAL (SQLite ./data)';
  console.log('======================================================');
  console.log(`ACTION: ${action.toUpperCase()}`);
  console.log(`TARGET: ${target}`);
  console.log('======================================================\n');
}

export function isNodeScript(cmd) {
  if (!cmd || path.resolve(cmd) === path.resolve(process.execPath)) return false;
  if (/\.(c?js|mjs)$/.test(cmd)) return true;
  if (!path.extname(cmd) && fs.existsSync(cmd)) {
    try {
      const fd = fs.openSync(cmd, 'r');
      try {
        const buf = Buffer.alloc(2);
        const bytesRead = fs.readSync(fd, buf, 0, 2, 0);
        return bytesRead === 2 && buf[0] === 0x23 && buf[1] === 0x21; // '#!'
      } finally {
        fs.closeSync(fd);
      }
    } catch {
      return false;
    }
  }
  return false;
}

/**
 * Run a command. Honors --dry-run globally via `dryRun`.
 * Uses shell only where required (Windows .cmd shims such as pnpm).
 */
export function run(cmd, args = [], opts = {}) {
  const {
    dryRun = false,
    capture = false,
    cwd = root,
    env,
    allowFail = false,
    quiet = false,
  } = opts;
  const printable =
    `${path.isAbsolute(cmd) ? path.relative(root, cmd) : cmd} ${args.join(' ')}`.trim();
  if (dryRun) {
    console.log(`  $ ${printable}`);
    return { status: 0, stdout: '', stderr: '' };
  }
  if (!quiet) console.log(`  $ ${printable}`);
  // Executable scripts are run through node; shell is only needed for .cmd shims (pnpm).
  // Extensionless shebang files (typescript's bin/tsc) are node scripts too — on
  // Windows cmd.exe can't exec them directly, so they go through node as well.
  const isScript = isNodeScript(cmd);
  const command = isScript ? process.execPath : cmd;
  const finalArgs = isScript ? [cmd, ...args] : args;
  const res = spawnSync(command, finalArgs, {
    stdio: capture ? ['ignore', 'pipe', 'pipe'] : 'inherit',
    encoding: 'utf8',
    cwd,
    env: { ...process.env, ...env },
    shell: process.platform === 'win32' && !isScript && !command.toLowerCase().endsWith('.exe'),
    maxBuffer: 64 * 1024 * 1024,
  });
  if (res.error) throw res.error;
  if (res.status !== 0 && !allowFail) {
    console.error(`command failed (exit ${res.status}): ${printable}`);
    if (capture) process.stderr.write(res.stderr ?? '');
    if (printable.includes('wrangler')) {
      printWranglerTroubleshooting(printable, `${res.stdout ?? ''}\n${res.stderr ?? ''}`);
    }
    process.exit(res.status ?? 1);
  }
  return { status: res.status ?? 0, stdout: res.stdout ?? '', stderr: res.stderr ?? '' };
}

export function step(title) {
  console.log(`\n==> ${title}`);
}

/**
 * Check whether Node.js meets the Vite 8 / Burrow runtime requirement (^20.19.0 || >=22.12.0).
 */
export function isSupportedNodeVersion(nodeVersion = process.versions.node) {
  const [major, minor] = String(nodeVersion)
    .replace(/^v/i, '')
    .split('.')
    .map((part) => Number.parseInt(part, 10));
  if (!Number.isFinite(major) || !Number.isFinite(minor)) return false;
  return (major === 20 && minor >= 19) || (major === 22 && minor >= 12) || major > 22;
}

/**
 * Validate local CLI prerequisites for Cloudflare and Node workflows.
 */
export function validateEnvironmentPreflight({
  nodeVersion = process.versions.node,
  resolveBin = bin,
  runFn = run,
  checkPnpm = true,
} = {}) {
  const errors = [];
  const warnings = [];
  const nodeMajor = Number(String(nodeVersion).replace(/^v/i, '').split('.')[0]);
  if (!isSupportedNodeVersion(nodeVersion)) {
    errors.push(
      `Node.js ^20.19.0 or >=22.12.0 is required (detected v${nodeVersion}). Upgrade Node.js and retry.`,
    );
  }

  let pnpmVersion = null;
  if (checkPnpm) {
    try {
      const res = runFn('pnpm', ['--version'], { capture: true, allowFail: true, quiet: true });
      if (res.status === 0 && res.stdout?.trim()) {
        pnpmVersion = res.stdout.trim();
      } else {
        errors.push('pnpm is not available on PATH. Install pnpm (https://pnpm.io/installation) and retry.');
      }
    } catch {
      errors.push('pnpm is not available on PATH. Install pnpm (https://pnpm.io/installation) and retry.');
    }
  }

  const requiredBins = [
    ['wrangler', undefined],
    ['typescript', 'tsc'],
    ['vite', undefined],
  ];
  for (const [pkg, sub] of requiredBins) {
    try {
      const binPath = resolveBin(pkg, sub);
      if (!binPath || (resolveBin === bin && !fs.existsSync(binPath))) {
        errors.push(`Missing dependency binary "${pkg}". Run \`pnpm install\` first.`);
      }
    } catch {
      errors.push(`Missing dependency "${pkg}". Run \`pnpm install\` first.`);
    }
  }

  return {
    ok: errors.length === 0,
    errors,
    warnings,
    details: { nodeVersion: String(nodeVersion), nodeMajor, pnpmVersion },
  };
}

/**
 * Extract unique 32-character Cloudflare account entries from `wrangler whoami --json`.
 */
export function collectAccounts(node) {
  const found = new Map();
  const visit = (n) => {
    if (!n) return;
    if (Array.isArray(n)) return n.forEach(visit);
    if (typeof n === 'object') {
      if (typeof n.id === 'string' && /^[0-9a-f]{32}$/i.test(n.id)) {
        found.set(n.id.toLowerCase(), { id: n.id, name: n.name });
      }
      for (const v of Object.values(n)) visit(v);
    }
  };
  visit(node);
  return [...found.values()];
}

/**
 * Resolve the target Cloudflare account safely without assuming a single account.
 */
export async function resolveCloudflareAccount({
  accounts = [],
  envAccountId,
  isInteractive = Boolean(process.stdin.isTTY),
  promptFn,
} = {}) {
  const trimmedEnv = envAccountId?.trim() || undefined;
  if (trimmedEnv) {
    if (accounts.length > 0) {
      const match = accounts.find((a) => a.id.toLowerCase() === trimmedEnv.toLowerCase());
      if (!match) {
        const available = accounts.map((a) => `${a.name ?? '(no name)'} (${a.id})`).join(', ');
        return {
          ok: false,
          error: `CLOUDFLARE_ACCOUNT_ID (${trimmedEnv}) does not match any account in the active Wrangler session. Available accounts: ${available}`,
        };
      }
      return { ok: true, accountId: match.id, accountName: match.name, selectedBy: 'env' };
    }
    return { ok: true, accountId: trimmedEnv, selectedBy: 'env' };
  }

  if (accounts.length === 0) {
    return { ok: true, accountId: null, selectedBy: 'default' };
  }

  if (accounts.length === 1) {
    return {
      ok: true,
      accountId: accounts[0].id,
      accountName: accounts[0].name,
      selectedBy: 'single',
    };
  }

  if (!isInteractive || !promptFn) {
    const listed = accounts.map((a, i) => `  [${i}] ${a.name ?? '(no name)'} (${a.id})`).join('\n');
    return {
      ok: false,
      error: [
        'Multiple Cloudflare accounts detected, and no CLOUDFLARE_ACCOUNT_ID is configured.',
        listed,
        'Set CLOUDFLARE_ACCOUNT_ID=<account-id> in .env (or your shell) and re-run.',
      ].join('\n'),
    };
  }

  const answer = String((await promptFn(accounts)) ?? '').trim();
  const numericIdx = /^\d+$/.test(answer) ? Number(answer) : -1;
  const chosen =
    accounts.find((a) => a.id.toLowerCase() === answer.toLowerCase()) ??
    (numericIdx >= 0 && numericIdx < accounts.length ? accounts[numericIdx] : null);

  if (!chosen) {
    return { ok: false, error: `No matching Cloudflare account selected for input "${answer}".` };
  }
  return { ok: true, accountId: chosen.id, accountName: chosen.name, selectedBy: 'prompt' };
}

/**
 * Validate wrangler.jsonc bindings and check for resource/UUID collisions.
 */
export function validateWranglerResourceConfig(
  cfg,
  { envD1Id, remoteDbs = [], remoteDbsLoaded = false } = {},
) {
  const errors = [];
  const warnings = [];

  if (!cfg || typeof cfg !== 'object') {
    return { ok: false, errors: ['Missing or invalid wrangler.jsonc configuration.'], warnings };
  }

  const workerName = cfg.name;
  if (!workerName) {
    errors.push('wrangler.jsonc is missing top-level "name".');
  }

  const d1 = cfg.d1_databases?.[0];
  if (!d1?.database_name) {
    errors.push('wrangler.jsonc is missing d1_databases[0].database_name.');
  }

  const dbName = d1?.database_name ?? null;
  const bucketName = cfg.r2_buckets?.[0]?.bucket_name ?? null;
  if (!bucketName) {
    warnings.push('wrangler.jsonc has no r2_buckets[0].bucket_name configured; file uploads require R2.');
  }

  if (errors.length > 0) {
    return { ok: false, errors, warnings, workerName, dbName, bucketName };
  }

  const matchingRemoteDbs = (Array.isArray(remoteDbs) ? remoteDbs : []).filter(
    (d) => d && (d.database_name === dbName || d.name === dbName),
  );
  if (matchingRemoteDbs.length > 1) {
    errors.push(
      `Multiple remote D1 databases matched name "${dbName}". Resolve ambiguity in Cloudflare Dashboard or set explicit D1_DATABASE_ID.`,
    );
  }

  const found = matchingRemoteDbs[0] ?? null;
  const remoteId = found ? (found.uuid ?? found.database_id ?? null) : null;
  let normalizedEnvId = envD1Id?.trim() || null;

  if (normalizedEnvId && remoteId && normalizedEnvId.toLowerCase() !== remoteId.toLowerCase()) {
    errors.push(
      `D1_DATABASE_ID collision: .env specifies "${normalizedEnvId}", but remote D1 database "${dbName}" has UUID "${remoteId}". Refusing to continue to avoid connecting to the wrong database.`,
    );
  } else if (normalizedEnvId && remoteDbsLoaded && !remoteId) {
    const idExistsOnAccount = (Array.isArray(remoteDbs) ? remoteDbs : []).some(
      (d) => d && (d.uuid ?? d.database_id ?? '').toLowerCase() === normalizedEnvId.toLowerCase(),
    );
    if (!idExistsOnAccount) {
      warnings.push(
        `Ignoring stale D1_DATABASE_ID "${normalizedEnvId}" in .env because it does not exist on the active Cloudflare account.`,
      );
      normalizedEnvId = null;
    }
  }

  if (errors.length > 0) {
    return { ok: false, errors, warnings, workerName, dbName, bucketName };
  }

  const resolvedId = remoteId ?? normalizedEnvId;
  const mode = resolvedId ? 'existing' : 'fresh';

  return {
    ok: true,
    mode,
    workerName,
    dbName,
    bucketName,
    d1Id: resolvedId,
    errors: [],
    warnings,
  };
}

/**
 * Compute an upgrade-safe Worker secret upload plan that preserves existing secrets.
 */
export function buildSecretPlan({
  existingSecrets = [],
  env = process.env,
  originForAuth,
  updateAuthUrl = false,
  rotateBootstrapToken = false,
  randomBytesFn = crypto.randomBytes,
} = {}) {
  const existingSet = new Set(
    existingSecrets instanceof Set
      ? [...existingSecrets]
      : (Array.isArray(existingSecrets) ? existingSecrets : []).map((s) =>
          typeof s === 'string' ? s : s?.name,
        ),
  );

  const toUpload = {};
  const preserved = [];
  let generatedBootstrapToken = null;

  if (existingSet.has('BETTER_AUTH_SECRET')) {
    preserved.push('BETTER_AUTH_SECRET');
  } else {
    const candidate = env.BETTER_AUTH_SECRET?.trim();
    const isStrongProdSecret =
      Boolean(candidate) &&
      candidate.length >= 32 &&
      !KNOWN_SECRET_PLACEHOLDERS.has(candidate);
    toUpload.BETTER_AUTH_SECRET = isStrongProdSecret
      ? candidate
      : randomBytesFn(32).toString('base64url');
  }

  if (existingSet.has('BOOTSTRAP_TOKEN') && !rotateBootstrapToken) {
    preserved.push('BOOTSTRAP_TOKEN');
  } else if (rotateBootstrapToken) {
    const token = getBootstrapToken(env);
    toUpload.BOOTSTRAP_TOKEN = token;
    generatedBootstrapToken = token;
  } else {
    const explicitToken = env.BOOTSTRAP_TOKEN?.trim();
    if (
      explicitToken &&
      explicitToken.length >= 16 &&
      !KNOWN_BOOTSTRAP_PLACEHOLDERS.has(explicitToken)
    ) {
      toUpload.BOOTSTRAP_TOKEN = explicitToken;
      generatedBootstrapToken = explicitToken;
    }
  }

  if (existingSet.has('BETTER_AUTH_URL') && !updateAuthUrl) {
    preserved.push('BETTER_AUTH_URL');
  } else if (originForAuth) {
    toUpload.BETTER_AUTH_URL = originForAuth;
  }

  for (const optionalKey of [
    'RESEND_API_KEY',
    'EMAIL_FROM',
    'GOOGLE_CLIENT_ID',
    'GOOGLE_CLIENT_SECRET',
    'GITHUB_CLIENT_ID',
    'GITHUB_CLIENT_SECRET',
    'SELF_UPDATE_WEBHOOK_URL',
  ]) {
    const val = env[optionalKey]?.trim();
    if (val) {
      toUpload[optionalKey] = val;
    }
  }

  return {
    toUpload,
    preserved,
    generatedBootstrapToken,
  };
}

/**
 * Classify raw Wrangler stdout/stderr into actionable troubleshooting guidance.
 */
export function classifyWranglerError(rawText = '') {
  const text = String(rawText);
  if (/10000|not logged in|authentication error|oauth token|expired/i.test(text)) {
    return {
      category: 'auth_expired',
      title: 'Cloudflare authentication missing or expired',
      steps: [
        'Verify your active session: `pnpm exec wrangler whoami`',
        'Re-authenticate interactively: `pnpm exec wrangler login`',
        'If running headless/CI, verify `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID`.',
      ],
    };
  }
  if (/10003|insufficient permissions|forbidden|unauthorized|not authorized/i.test(text)) {
    return {
      category: 'permissions_missing',
      title: 'Cloudflare account or API token lacks required permissions',
      steps: [
        'Ensure your user/token can edit Workers Scripts, D1, and R2.',
        'Confirm `CLOUDFLARE_ACCOUNT_ID` selects the intended account.',
      ],
    };
  }
  if (/10042|enable r2|r2 subscription|r2.*not enabled/i.test(text)) {
    return {
      category: 'r2_disabled',
      title: 'Cloudflare R2 is not enabled on this account',
      steps: [
        'Open the Cloudflare Dashboard -> R2 Object Storage and activate R2 for this account (free tier available; requires payment method on file per Cloudflare policy).',
        'Re-run `pnpm run setup -r` once R2 is activated.',
      ],
    };
  }
  if (/database_id|7403|could not find database|d1/i.test(text)) {
    return {
      category: 'd1_uuid',
      title: 'Cloudflare D1 database configuration or UUID issue',
      steps: [
        'Inspect your account databases: `pnpm exec wrangler d1 list`',
        'Check whether `D1_DATABASE_ID` in `.env` matches `wrangler.jsonc` (`database_name`).',
        'Run `pnpm run setup -r` to discover or provision the D1 database.',
      ],
    };
  }
  return {
    category: 'unknown',
    title: 'Wrangler command failed',
    steps: [
      'Verify active login and account: `pnpm exec wrangler whoami`',
      'Inspect configuration in `wrangler.jsonc` and `.env`.',
    ],
  };
}

/** Parse a JSON string that may contain comments or trailing commas (JSONC). */
export function parseJsonc(text) {
  const cleaned = text.replace(/\/\*[\s\S]*?\*\/|\/\/.*/g, '').replace(/,(\s*[}\]])/g, '$1');
  return JSON.parse(cleaned);
}

/** Parse the first JSON value found in a string (wrangler mixes logs with output). */
export function parseFirstJson(text) {
  const start = text.search(/[[{]/);
  if (start === -1) return null;
  try {
    return JSON.parse(text.slice(start));
  } catch {
    return null;
  }
}

/**
 * Post-deployment application verification beyond Worker CLI exit status:
 * checks API health, auth configuration initialization, version endpoint, and SPA HTML delivery.
 */
export async function verifyDeployment(
  url,
  { attempts = 3, delayMs = 2000, fetchFn = fetch } = {},
) {
  const baseUrl = String(url).replace(/\/+$/, '');
  const checks = { health: false, authConfig: false, version: false, frontend: false };
  const errors = [];

  for (let i = 1; i <= attempts; i++) {
    try {
      const res = await fetchFn(`${baseUrl}/api/health`);
      if (res.ok) {
        const body = await res.json();
        if (body?.ok === true) {
          checks.health = true;
          console.log(`  [check 1/4] /api/health OK: ${JSON.stringify(body)}`);
          break;
        }
        errors.push(`/api/health returned unexpected JSON payload`);
      } else {
        console.warn(`  /api/health got HTTP ${res.status} (attempt ${i}/${attempts})`);
      }
    } catch (err) {
      console.warn(`  /api/health failed: ${err instanceof Error ? err.message : err} (attempt ${i}/${attempts})`);
    }
    if (i < attempts) await new Promise((r) => setTimeout(r, delayMs));
  }

  if (!checks.health) {
    if (errors.length === 0) errors.push(`GET ${baseUrl}/api/health failed after ${attempts} attempt(s).`);
    console.error(`  verification failed: ${errors[0]}`);
    return { ok: false, checks, errors };
  }

  try {
    const authRes = await fetchFn(`${baseUrl}/api/auth/config`);
    if (!authRes.ok) {
      errors.push(`GET ${baseUrl}/api/auth/config returned HTTP ${authRes.status}`);
    } else {
      const cfg = await authRes.json();
      if (cfg?.emailPasswordEnabled === true && typeof cfg?.signupMode === 'string') {
        checks.authConfig = true;
        console.log(`  [check 2/4] /api/auth/config OK (signupMode=${cfg.signupMode})`);
      } else {
        errors.push('/api/auth/config payload missing required auth initialization fields');
      }
    }
  } catch (err) {
    errors.push(`/api/auth/config check failed: ${err instanceof Error ? err.message : err}`);
  }

  try {
    const verRes = await fetchFn(`${baseUrl}/api/system/version`);
    if (!verRes.ok) {
      errors.push(`GET ${baseUrl}/api/system/version returned HTTP ${verRes.status}`);
    } else {
      const ver = await verRes.json();
      if (typeof ver?.currentVersion === 'string') {
        checks.version = true;
        console.log(`  [check 3/4] /api/system/version OK (v${ver.currentVersion})`);
      } else {
        errors.push('/api/system/version payload missing currentVersion');
      }
    }
  } catch (err) {
    errors.push(`/api/system/version check failed: ${err instanceof Error ? err.message : err}`);
  }

  try {
    const htmlRes = await fetchFn(`${baseUrl}/`);
    if (!htmlRes.ok) {
      errors.push(`GET ${baseUrl}/ returned HTTP ${htmlRes.status}`);
    } else {
      const html = await htmlRes.text();
      if (/<div\s+id=["']root["']|<!doctype\s+html/i.test(html)) {
        checks.frontend = true;
        console.log('  [check 4/4] Frontend SPA root HTML OK');
      } else {
        errors.push('GET / did not return expected SPA HTML shell');
      }
    }
  } catch (err) {
    errors.push(`Frontend HTML check failed: ${err instanceof Error ? err.message : err}`);
  }

  const ok = checks.health && checks.authConfig && checks.version && checks.frontend;
  if (!ok) {
    for (const msg of errors) console.error(`  verification error: ${msg}`);
  }
  return { ok, checks, errors };
}

export async function smoke(url, opts = {}) {
  const result = await verifyDeployment(url, opts);
  return result.ok;
}

/** Load environment variables from .env if present. */
export function loadEnv(target = process.env) {
  return canonicalLoadEnv({ rootDir: root, env: target });
}

/**
 * Returns wrangler CLI config args (--config wrangler.local.jsonc).
 * Auto-discovers D1_DATABASE_ID from Cloudflare if not provided in process.env,
 * and writes only to git-ignored ephemeral wrangler.local.jsonc (never mutates .env).
 */
export function getWranglerConfigArgs(options = {}) {
  const {
    d1IdOverride = null,
    required = false,
    purpose = 'deployment',
    ignoreCached = false,
    profile: suppliedProfile = null,
  } = typeof options === 'string' ? { d1IdOverride: options } : options;

  loadEnv();
  const baseConfig = readBaseWranglerConfig();
  const profile = suppliedProfile || resolveRemoteProfile(baseConfig);
  let d1Id = d1IdOverride || (!ignoreCached ? profile.envD1Id : null);
  const localConfigPath = path.join(root, profile.localConfigFilename);

  if (!d1Id && !ignoreCached && fs.existsSync(localConfigPath)) {
    try {
      const existingLocal = parseJsonc(fs.readFileSync(localConfigPath, 'utf8'));
      if (existingLocal.d1_databases?.[0]?.database_id) {
        d1Id = existingLocal.d1_databases[0].database_id;
      }
    } catch (_err) {
      void _err;
    }
  }

  if (!d1Id) {
    try {
      const dbName = profile.dbName;
      if (dbName) {
        const list = run(bin('wrangler'), ['d1', 'list', '--json'], {
          capture: true,
          quiet: true,
          allowFail: true,
        });
        if (list.status === 0) {
          const dbs = parseFirstJson(list.stdout) ?? [];
          const found = dbs.find((d) => d.database_name === dbName || d.name === dbName);
          if (found) {
            d1Id = found.uuid ?? found.database_id;
            console.log(`  💡 Auto-discovered remote D1 database "${dbName}" (${d1Id})`);
          }
        }
      }
    } catch (_err) {
      void _err;
    }
  }

  if (!d1Id) {
    if (required) {
      printMissingD1Error(purpose);
      process.exit(1);
    }
    return [];
  }

  // Create or update git-ignored ephemeral Wrangler config for Wrangler CLI
  const localConfig = JSON.parse(JSON.stringify(profile.effectiveConfig));
  if (localConfig.d1_databases?.[0]) {
    localConfig.d1_databases[0].database_id = d1Id;
  }
  fs.writeFileSync(localConfigPath, JSON.stringify(localConfig, null, 2) + '\n');
  return ['--config', profile.localConfigFilename];
}

function printMissingD1Error(purpose) {
  console.error('\n' + '='.repeat(80));
  console.error(`❌ D1 DATABASE CONFIGURATION REQUIRED FOR ${purpose.toUpperCase()}`);
  console.error('='.repeat(80));
  console.error('Could not resolve your Cloudflare D1 Database ID.\n');
  console.error('🔍 Why this happens:');
  console.error('  Cloudflare D1 requires a 36-character database UUID for remote operations');
  console.error('  (migrations, time-travel, deployments). Either the database has not been');
  console.error('  provisioned yet, or your Wrangler CLI session is not logged in.\n');
  console.error('🛠️ How to fix:');
  console.error('  Option 1: Run the one-command setup to provision all Cloudflare resources:');
  console.error('    pnpm run setup -r\n');
  console.error('  Option 2: If your Cloudflare login session has expired:');
  console.error('    pnpm exec wrangler login');
  console.error('='.repeat(80) + '\n');
}

function printWranglerTroubleshooting(printable, rawOutput = '') {
  const diagnosis = classifyWranglerError(rawOutput);
  console.error('\n' + '='.repeat(80));
  console.error('💡 WRANGLER TROUBLESHOOTING GUIDE');
  console.error('='.repeat(80));
  if (diagnosis.category !== 'unknown') {
    console.error(`Detected issue: ${diagnosis.title}`);
    for (const s of diagnosis.steps) {
      console.error(`  - ${s}`);
    }
  }
  if (printable.includes('d1')) {
    console.error('• D1 operations:');
    console.error('  - Cloudflare D1 requires a valid 36-character database UUID.');
    console.error('  - Run `pnpm run setup -r` to provision or auto-discover the database.');
    console.error('  - Or run `pnpm exec wrangler d1 list` to inspect your account databases.');
  }
  console.error('• Authentication or Permission errors:');
  console.error('  - Verify active login and account: `pnpm exec wrangler whoami`');
  console.error('  - Re-authenticate if session expired: `pnpm exec wrangler login`');
  console.error('• First-time setup:');
  console.error('  - Run `pnpm run setup -r` for automatic one-command provisioning.');
  console.error('='.repeat(80) + '\n');
}

export function inspectOrCleanRemoteR2References({
  configArgs,
  profile,
  cleanR2 = false,
  runFn = run,
}) {
  const query = [
    'SELECT storage_key AS key FROM project_files',
    "UNION SELECT cover_key AS key FROM notepads WHERE cover_key IS NOT NULL AND cover_key != ''",
  ].join(' ');
  const check = runFn(
    bin('wrangler'),
    [...configArgs, 'd1', 'execute', profile.dbName, '--remote', `--command=${query}`, '--json'],
    { capture: true, allowFail: true, quiet: true },
  );
  if (check.status !== 0) return [];

  const parsed = parseFirstJson(check.stdout);
  const resultSets = Array.isArray(parsed) ? parsed : [parsed];
  const rows = resultSets[0]?.results ?? resultSets[0]?.rows ?? [];
  const keys = Array.from(
    new Set(rows.map((row) => row?.key).filter((k) => typeof k === 'string' && k.length > 0)),
  );
  if (keys.length === 0) return [];

  if (cleanR2) {
    console.log(
      `  💡 Cleaning ${keys.length} R2 object reference(s) from bucket "${profile.bucketName}" before wiping D1...`,
    );
    for (const key of keys) {
      const del = runFn(
        bin('wrangler'),
        [...configArgs, 'r2', 'object', 'delete', `${profile.bucketName}/${key}`, '--remote'],
        { capture: true, allowFail: true, quiet: true },
      );
      if (del.status !== 0) {
        console.warn(`  ⚠️  Failed to delete R2 object "${key}" from "${profile.bucketName}"`);
      }
    }
  } else {
    console.warn(
      `  ⚠️  Found ${keys.length} referenced R2 object(s) in bucket "${profile.bucketName}" before wiping D1.`,
    );
    console.warn(
      `     Those objects will become unreferenced after reset; inspect them with \`pnpm run inventory:storage\`.`,
    );
  }
  return keys;
}

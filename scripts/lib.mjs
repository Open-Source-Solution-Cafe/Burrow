import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadEnv as canonicalLoadEnv } from '../src/server/env.ts';
import { selectDatabaseTarget } from '../src/server/database-target.ts';
import { splitSqlStatements } from '../src/server/sql-statements.ts';

export const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/**
 * Resolves the bootstrap token for local development, setup, and click-through tests.
 * Never uses hardcoded or predictable default tokens ('dev-bootstrap-token', 'test-bootstrap-token').
 * If a custom token (>= 16 characters) is not explicitly provided, generates a unique,
 * cryptographically secure 32-character hex token.
 */
export function getBootstrapToken(env = process.env) {
  const token = env.BOOTSTRAP_TOKEN?.trim();
  const knownPlaceholders = new Set(['dev-bootstrap-token', 'test-bootstrap-token']);
  return token && !knownPlaceholders.has(token) && token.length >= 16
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

export function argValue(flag, fallback = undefined) {
  const args = process.argv.slice(2);
  const i = args.findIndex((a) => a === flag || a.startsWith(`${flag}=`));
  if (i === -1) return fallback;
  const a = args[i];
  if (a.includes('=')) return a.slice(a.indexOf('=') + 1);
  return args[i + 1];
}

export function hasFlag(flag) {
  return process.argv.slice(2).some((a) => a === flag || a.startsWith(`${flag}=`));
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

export async function migrateDatabase(
  target,
  { dryRun = false, configArgs, databaseName = 'burrow' } = {},
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
  run(bin('wrangler'), ['d1', 'migrations', 'apply', databaseName, ...targetArgs], {
    dryRun,
    env: { CI: '1' },
  });
}

/** Execute the canonical SQL file on the selected DB; invariant queries are semicolon-delimited. */
export async function executeDatabaseFile(target, sqlFile, { readOnly = false } = {}) {
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
  const res = run(
    bin('wrangler'),
    ['d1', 'execute', 'burrow', ...d1TargetArgs(target), '--file', sqlFile, '--json'],
    { capture: true, quiet: true },
  );
  const parsed = parseFirstJson(res.stdout);
  if (parsed === null) throw new Error('Could not parse d1 execute output');
  return Array.isArray(parsed) ? parsed : [parsed];
}

/** Print a loud, prominent target banner at the start of a command. */
export function printTargetBanner(action, isRemote) {
  const target =
    typeof isRemote === 'object'
      ? isRemote.kind === 'node'
        ? `💻 LOCAL SQLite (${isRemote.sqlitePath})`
        : isRemote.kind === 'worker'
          ? `💻 LOCAL Worker/D1 (${isRemote.persistTo})`
          : isRemote.kind === 'postgres'
            ? `PostgreSQL (${new URL(isRemote.url).host}${new URL(isRemote.url).pathname})`
            : '☁️  REMOTE (Cloudflare Production)'
      : isRemote
        ? '☁️  REMOTE (Cloudflare Production)'
        : '💻 LOCAL (SQLite ./data)';
  console.log('======================================================');
  console.log(`ACTION: ${action.toUpperCase()}`);
  console.log(`TARGET: ${target}`);
  console.log('======================================================\n');
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
  // Extensionless files (typescript's bin/tsc) are node shebang scripts too — on
  // Windows cmd.exe can't exec them directly, so they go through node as well.
  const isScript = /\.(c?js|mjs)$/.test(cmd) || (!path.extname(cmd) && fs.existsSync(cmd));
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
      printWranglerTroubleshooting(printable);
    }
    process.exit(res.status ?? 1);
  }
  return { status: res.status ?? 0, stdout: res.stdout ?? '', stderr: res.stderr ?? '' };
}

export function step(title) {
  console.log(`\n==> ${title}`);
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

export async function smoke(url, { attempts = 3, delayMs = 2000 } = {}) {
  for (let i = 1; i <= attempts; i++) {
    try {
      const res = await fetch(`${url}/api/health`);
      if (res.ok) {
        const body = await res.json();
        console.log(`  health check OK: ${JSON.stringify(body)}`);
        return true;
      }
      console.warn(`  health check got HTTP ${res.status} (attempt ${i}/${attempts})`);
    } catch (err) {
      console.warn(`  health check failed: ${err} (attempt ${i}/${attempts})`);
    }
    if (i < attempts) await new Promise((r) => setTimeout(r, delayMs));
  }
  console.error(`  smoke test failed for ${url}/api/health`);
  return false;
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
  } = typeof options === 'string' ? { d1IdOverride: options } : options;

  loadEnv();
  let d1Id =
    d1IdOverride ||
    (!ignoreCached ? process.env.D1_DATABASE_ID || process.env.CLOUDFLARE_D1_DATABASE_ID : null);
  const configPath = path.join(root, 'wrangler.jsonc');
  const baseConfig = parseJsonc(fs.readFileSync(configPath, 'utf8'));
  const localConfigPath = path.join(root, 'wrangler.local.jsonc');

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
      const dbName = baseConfig.d1_databases?.[0]?.database_name;
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

  // Create or update git-ignored ephemeral wrangler.local.jsonc for Wrangler CLI
  const localConfig = JSON.parse(JSON.stringify(baseConfig));
  if (localConfig.d1_databases?.[0]) {
    localConfig.d1_databases[0].database_id = d1Id;
  }
  fs.writeFileSync(localConfigPath, JSON.stringify(localConfig, null, 2) + '\n');
  return ['--config', 'wrangler.local.jsonc'];
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
  console.error('    pnpm run setup\n');
  console.error('  Option 2: If your Cloudflare login session has expired:');
  console.error('    pnpm exec wrangler login');
  console.error('='.repeat(80) + '\n');
}

function printWranglerTroubleshooting(printable) {
  console.error('\n' + '='.repeat(80));
  console.error('💡 WRANGLER TROUBLESHOOTING GUIDE');
  console.error('='.repeat(80));
  if (printable.includes('d1')) {
    console.error('• D1 "Authentication error [code: 10000]":');
    console.error('  - Cloudflare D1 requires a valid 36-character database UUID.');
    console.error('  - Run `pnpm run setup` to provision or auto-discover the database.');
    console.error('  - Or run `pnpm exec wrangler d1 list` to inspect your account databases.');
  }
  console.error('• Authentication or Permission errors:');
  console.error('  - Verify active login and account: `pnpm exec wrangler whoami`');
  console.error('  - Re-authenticate if session expired: `pnpm exec wrangler login`');
  console.error('• First-time setup:');
  console.error('  - Run `pnpm run setup` for automatic one-command provisioning.');
  console.error('='.repeat(80) + '\n');
}

#!/usr/bin/env node
/**
 * Release. Run with `pnpm run deploy` (production) or `pnpm run deploy:staging` (staging).
 * Preflight -> check -> build -> record D1 Time Travel bookmark -> migrate remote -> deploy -> verify.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  bin,
  collectAccounts,
  getWranglerConfigArgs,
  hasFlag,
  loadEnv,
  migrateDatabase,
  parseFirstJson,
  parseJsonc,
  printTargetBanner,
  resolveCloudflareAccount,
  resolveRemoteProfile,
  root,
  run,
  step,
  validateEnvironmentPreflight,
  validateWranglerResourceConfig,
  verifyDeployment,
} from './lib.mjs';
import { syncUpstreamRepo } from './sync-upstream.mjs';

export function isWorkersCiBuild(env = process.env) {
  const flag = String(env.WORKERS_CI ?? '').trim().toLowerCase();
  return flag === '1' || flag === 'true';
}

/**
 * Apply disk-based plugin SQL migrations (`migrations/plugins/<pluginId>/*.sql`)
 * against the target D1 database via `plugin_migrations` before `wrangler deploy`.
 * Plugins declaring TypeScript-bundled migrations also auto-migrate idempotently on Worker boot.
 */
export async function applyPluginMigrationsBeforeDeploy({
  databaseName,
  configArgs = [],
  pluginMigrationsDir = path.join(root, 'migrations', 'plugins'),
  runFn = run,
  dryRun = false,
} = {}) {
  if (!fs.existsSync(pluginMigrationsDir)) {
    return [];
  }
  const pluginDirs = fs
    .readdirSync(pluginMigrationsDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
  if (pluginDirs.length === 0) return [];

  const targetArgs = [...configArgs, '--remote'];
  const createLedgerSql =
    'CREATE TABLE IF NOT EXISTS plugin_migrations (plugin_id TEXT NOT NULL, name TEXT NOT NULL, applied_at INTEGER NOT NULL, PRIMARY KEY (plugin_id, name));';
  runFn(bin('wrangler'), ['d1', 'execute', databaseName, ...targetArgs, '--command', createLedgerSql], {
    dryRun,
    env: { CI: '1' },
  });

  const applied = new Set();
  if (!dryRun) {
    const queryRes = runFn(
      bin('wrangler'),
      ['d1', 'execute', databaseName, ...targetArgs, '--command', 'SELECT plugin_id, name FROM plugin_migrations;', '--json'],
      { capture: true, quiet: true, allowFail: true, env: { CI: '1' } },
    );
    if (queryRes.status === 0) {
      const parsed = parseFirstJson(queryRes.stdout ?? '');
      const rows = Array.isArray(parsed) ? (parsed[0]?.results ?? []) : [];
      for (const row of rows) {
        if (row?.plugin_id && row?.name) {
          applied.add(`${row.plugin_id}:${row.name}`);
        }
      }
    }
  }

  const appliedNow = [];
  for (const pluginId of pluginDirs) {
    const dir = path.join(pluginMigrationsDir, pluginId);
    const files = fs.readdirSync(dir).filter((f) => f.endsWith('.sql')).sort();
    for (const file of files) {
      const key = `${pluginId}:${file}`;
      if (applied.has(key)) continue;
      const sqlFile = path.join(dir, file);
      runFn(bin('wrangler'), ['d1', 'execute', databaseName, ...targetArgs, '--file', sqlFile], {
        dryRun,
        env: { CI: '1' },
      });
      const recordSql = `INSERT OR IGNORE INTO plugin_migrations (plugin_id, name, applied_at) VALUES ('${pluginId.replace(/'/g, "''")}', '${file.replace(/'/g, "''")}', ${Date.now()});`;
      runFn(bin('wrangler'), ['d1', 'execute', databaseName, ...targetArgs, '--command', recordSql], {
        dryRun,
        env: { CI: '1' },
      });
      appliedNow.push(key);
    }
  }
  return appliedNow;
}

export function resolveWorkersCiConfigArgs(
  baseCfg,
  { env = process.env, rootDir = root, runFn = run, wranglerBin = bin('wrangler') } = {},
) {
  const d1Binding = baseCfg?.d1_databases?.[0];
  if (!d1Binding || d1Binding.database_id?.trim()) {
    return [];
  }

  let d1Id = (env.D1_DATABASE_ID || env.CLOUDFLARE_D1_DATABASE_ID)?.trim() || null;
  if (!d1Id && d1Binding.database_name) {
    const list = runFn(wranglerBin, ['d1', 'list', '--json'], {
      capture: true,
      quiet: true,
      allowFail: true,
    });
    if (list.status === 0) {
      const dbs = parseFirstJson(list.stdout ?? '') ?? [];
      const found = dbs.find(
        (d) => d.database_name === d1Binding.database_name || d.name === d1Binding.database_name,
      );
      if (found) {
        d1Id = found.uuid ?? found.database_id ?? null;
        if (d1Id) {
          console.log(`  💡 Auto-discovered remote D1 database "${d1Binding.database_name}" (${d1Id})`);
        }
      }
    }
  }

  if (!d1Id) {
    return [];
  }

  const localConfigFilename = 'wrangler.local.jsonc';
  const localConfig = JSON.parse(JSON.stringify(baseCfg));
  localConfig.d1_databases[0].database_id = d1Id;
  fs.writeFileSync(
    path.join(rootDir, localConfigFilename),
    JSON.stringify(localConfig, null, 2) + '\n',
  );
  return ['--config', localConfigFilename];
}

export function ensureSdkBuilt({ rootDir = root, runFn = run, dryRun = false } = {}) {
  const sdkTsconfig = path.join(rootDir, 'packages', 'sdk', 'tsconfig.build.json');
  const sdkDistEntry = path.join(rootDir, 'packages', 'sdk', 'dist', 'index.js');
  if (fs.existsSync(sdkTsconfig) && !fs.existsSync(sdkDistEntry)) {
    step('Build @burrow/sdk (packages/sdk/dist missing)');
    runFn(bin('typescript', 'tsc'), ['-p', sdkTsconfig], { dryRun });
    return true;
  }
  return false;
}

async function runWorkersCiDeploy(baseCfg) {
  step('Cloudflare Workers Builds detected (WORKERS_CI=1)');
  console.log(`  worker: ${baseCfg?.name ?? '(wrangler.jsonc default)'}`);

  const autoSync =
    hasFlag('--sync-upstream') ||
    String(process.env.BURROW_AUTO_SYNC_UPSTREAM ?? '').trim().toLowerCase() === 'true';
  if (autoSync) {
    step('Sync upstream Burrow before deploy (--no-commit)');
    const syncRes = syncUpstreamRepo({
      cwd: root,
      upstreamUrl: process.env.BURROW_UPSTREAM_URL || undefined,
      upstreamBranch: process.env.BURROW_UPSTREAM_BRANCH || undefined,
      noCommit: true,
    });
    if (syncRes.updated) {
      step('Install dependencies and rebuild synced upstream release');
      run('pnpm', ['install', '--frozen-lockfile']);
      run('pnpm', ['run', 'build']);
    }
  }

  ensureSdkBuilt();

  if (!fs.existsSync(path.join(root, 'dist', 'web', 'index.html'))) {
    step('Build SPA assets (dist/web missing)');
    run(bin('vite'), ['build']);
  }

  const configArgs = resolveWorkersCiConfigArgs(baseCfg);
  const extraArgs = process.argv.slice(2).filter((arg) => arg !== '--sync-upstream');
  step('Deploy Worker via Wrangler');
  run(bin('wrangler'), [...configArgs, 'deploy', ...extraArgs]);
  console.log('\ndeploy complete');
}

async function main() {
  loadEnv();
  const baseCfg = parseJsonc(fs.readFileSync(path.join(root, 'wrangler.jsonc'), 'utf8'));

  if (isWorkersCiBuild(process.env)) {
    await runWorkersCiDeploy(baseCfg);
    return;
  }

  const profile = resolveRemoteProfile(baseCfg);
  const domain = profile.domain;
  const skipChecks = profile.isStaging && hasFlag('--skip-checks');
  const WRANGLER_ARGS =
    profile.isStaging || profile.isDemo || hasFlag('--name') ? ['--name', profile.workerName] : [];

  const bannerLabel = profile.isStaging
    ? 'Staging Deploy'
    : profile.isDemo
      ? 'Demo Deploy'
      : 'Production Deploy';
  printTargetBanner(bannerLabel, true, { profile });

  step('Preflight check (environment, Cloudflare auth & D1 configuration)');
  const preflight = validateEnvironmentPreflight();
  if (!preflight.ok) {
    for (const err of preflight.errors) console.error(`  ❌ ${err}`);
    process.exit(1);
  }

  const whoami = run(bin('wrangler'), ['whoami', '--json'], {
    capture: true,
    allowFail: true,
    quiet: true,
  });
  if (whoami.status !== 0) {
    console.error('  ❌ Cloudflare Wrangler session missing or expired. Run `pnpm exec wrangler login` and retry.');
    process.exit(1);
  }
  const accounts = collectAccounts(parseFirstJson(whoami.stdout ?? ''));
  const accountSelection = await resolveCloudflareAccount({
    accounts,
    envAccountId: process.env.CLOUDFLARE_ACCOUNT_ID,
    isInteractive: Boolean(process.stdin.isTTY),
  });
  if (!accountSelection.ok) {
    console.error(`  ❌ ${accountSelection.error}`);
    process.exit(1);
  }
  if (accountSelection.accountId) {
    process.env.CLOUDFLARE_ACCOUNT_ID = accountSelection.accountId;
    console.log(
      `  account: ${accountSelection.accountName ?? '(unnamed)'} (${accountSelection.accountId})`,
    );
  }

  const d1ListRes = run(bin('wrangler'), ['d1', 'list', '--json'], {
    capture: true,
    allowFail: true,
    quiet: true,
  });
  const remoteDbsLoaded = d1ListRes.status === 0;
  const remoteDbs = remoteDbsLoaded ? (parseFirstJson(d1ListRes.stdout) ?? []) : [];
  const resourceCheck = validateWranglerResourceConfig(profile.effectiveConfig, {
    envD1Id: profile.envD1Id,
    remoteDbs,
    remoteDbsLoaded,
  });
  if (!resourceCheck.ok) {
    for (const err of resourceCheck.errors) console.error(`  ❌ ${err}`);
    process.exit(1);
  }
  for (const warn of resourceCheck.warnings) console.warn(`  ⚠️  ${warn}`);

  const configArgs = getWranglerConfigArgs({
    d1IdOverride: resourceCheck.d1Id,
    required: true,
    purpose: 'deploying',
    profile,
  });
  const dbName = resourceCheck.dbName || profile.dbName;

  if (skipChecks) {
    step('Check skipped (--staging --skip-checks)');
  } else {
    if (hasFlag('--skip-checks') && !profile.isStaging) {
      console.warn('  ⚠️  Ignoring --skip-checks on production deployment.');
    }
    step('Check (typecheck, lint, tests)');
    run(path.join(root, 'scripts', 'check.mjs'), ['--sqlite']);
  }

  step('Build');
  ensureSdkBuilt();
  run(bin('vite'), ['build']);

  step('Record D1 Time Travel bookmark (rollback point)');
  const tt = run(
    bin('wrangler'),
    [...configArgs, 'd1', 'time-travel', 'info', dbName, '--remote', '--json'],
    {
      capture: true,
      allowFail: true,
      quiet: true,
    },
  );
  if (tt.status === 0) {
    const info = parseFirstJson(tt.stdout) ?? {};
    const bookmark = info.bookmark ?? info;
    const line = `${new Date().toISOString()}  [${profile.envName}:${dbName}]  ${JSON.stringify(bookmark)}`;
    const logDir = path.join(root, '.deploy-log');
    fs.mkdirSync(logDir, { recursive: true });
    fs.appendFileSync(path.join(logDir, 'rollbacks.log'), line + '\n');
    console.log(`  bookmark saved to .deploy-log/rollbacks.log: ${JSON.stringify(bookmark)}`);
  } else {
    console.warn('  could not read a Time Travel bookmark (new database?): continuing');
  }

  step('Apply pending migrations to remote D1 (before uploading code)');
  await migrateDatabase(
    { kind: 'remote' },
    { configArgs, databaseName: dbName, allowPreBaselineReset: false },
  );
  await applyPluginMigrationsBeforeDeploy({ databaseName: dbName, configArgs });

  step('Deploy');
  const deployArgs = [...configArgs, 'deploy', ...WRANGLER_ARGS];
  if (domain && !domain.endsWith('.workers.dev')) deployArgs.push('--domains', domain);
  const deploy = run(bin('wrangler'), deployArgs, { capture: true });
  const url = domain
    ? `https://${domain}`
    : deploy.stdout.match(/https:\/\/[^\s]*workers\.dev[^\s]*/)?.[0];
  if (url) console.log(`  deployed: ${url}`);

  step('Verify deployment (health, auth config, version & SPA assets)');
  if (url) {
    const verification = await verifyDeployment(url, { attempts: 10, delayMs: 3000 });
    if (!verification.ok) {
      console.error(
        '  ❌ Worker deployment uploaded, but post-deploy verification failed. Check logs and consider Time Travel rollback.',
      );
      process.exit(1);
    }
  } else {
    console.warn('  no deployed URL found in output — skipping post-deploy verification');
  }
  console.log('\ndeploy complete');
}

const isMain =
  Boolean(process.argv[1]) && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isMain) {
  main().catch((err) => {
    console.error('\n❌ Deploy failed:', err instanceof Error ? err.message : err);
    process.exit(1);
  });
}

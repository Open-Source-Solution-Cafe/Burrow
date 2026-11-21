#!/usr/bin/env node
/**
 * One-command setup. Idempotent and retry-safe. Run with `pnpm run setup`.
 *
 * Targets:
 *   (default)              Local setup (installs deps, migrates Node SQLite, prints dev URLs & token)
 *   --worker               Local Worker/D1 persisted under ./data
 *   --remote, --r, -r      Remote setup (provisions Cloudflare D1/R2, migrates, builds, deploys, sets secrets)
 *
 * Flags:
 *   --staging                Target isolated staging resources (burrow-staging)
 *   --dry-run                Print every stage and command without running mutations
 *   --domain <domain>        Attach a custom domain (remote only; must be on Cloudflare DNS in this account)
 *   --name <worker-name>     Deploy under a different worker name (remote only)
 *   --rotate-bootstrap-token Generate/apply a new BOOTSTRAP_TOKEN even if one already exists on the Worker
 */
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline/promises';
import {
  bin,
  buildSecretPlan,
  collectAccounts,
  getDatabaseTarget,
  getWranglerConfigArgs,
  hasFlag,
  KNOWN_BOOTSTRAP_PLACEHOLDERS,
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
  upsertEnvVar,
  validateEnvironmentPreflight,
  validateWranglerResourceConfig,
  verifyDeployment,
} from './lib.mjs';

const dryRun = hasFlag('--dry-run');
const rotateBootstrapToken = hasFlag('--rotate-bootstrap-token');
const target = getDatabaseTarget();
const isRemote = target.kind === 'remote';
const configPath = path.join(root, 'wrangler.jsonc');
const baseCfg = parseJsonc(fs.readFileSync(configPath, 'utf8'));
const profile = isRemote ? resolveRemoteProfile(baseCfg) : null;
const domain = profile?.domain;
const WRANGLER_ARGS =
  profile && (profile.isStaging || profile.isDemo || hasFlag('--name'))
    ? ['--name', profile.workerName]
    : [];

function stageHeader(num, label) {
  step(`Stage ${num}/10 — ${label}`);
}

async function main() {
  printTargetBanner('Setup', target, { profile });

  stageHeader(1, 'Checking environment');
  loadEnv();
  const preflight = validateEnvironmentPreflight({ checkPnpm: !dryRun });
  if (!preflight.ok) {
    for (const err of preflight.errors) {
      console.error(`  ❌ ${err}`);
    }
    process.exit(1);
  }
  console.log(
    `  node ${process.version}${preflight.details.pnpmVersion ? `, pnpm ${preflight.details.pnpmVersion}` : ''}, dry-run: ${dryRun}`,
  );
  run('pnpm', ['install'], { dryRun });

  if (!isRemote) {
    step('Apply migrations to the selected local database');
    await migrateDatabase(target, { dryRun });
    const rawBootstrap = process.env.BOOTSTRAP_TOKEN?.trim() || '';
    const explicitBootstrap =
      rawBootstrap.length >= 16 && !KNOWN_BOOTSTRAP_PLACEHOLDERS.has(rawBootstrap)
        ? rawBootstrap
        : '';
    const localUrl = process.env.BETTER_AUTH_URL || 'http://localhost:3005';
    console.log('\n======================================================');
    console.log('✅ Local setup complete!');
    console.log(`  Local Web URL:      ${localUrl}`);
    console.log('  Local Backend API:  http://127.0.0.1:8787');
    console.log(`  BETTER_AUTH_URL:    ${localUrl}`);
    console.log('  BETTER_AUTH_SECRET: [configured]');
    console.log(
      explicitBootstrap
        ? `  BOOTSTRAP_TOKEN:    ${explicitBootstrap}`
        : '  Initial Owner:      First account registered at /login claims Owner (then locks to invite-only)',
    );
    console.log('======================================================');
    console.log(
      `\nRun \`pnpm ${target.kind === 'worker' ? 'dev:worker' : 'dev'}\` to start development.`,
    );
    console.log('To set up remote Cloudflare production instead, run:');
    console.log('  pnpm run setup -r\n');
    return;
  }

  // --- Remote Cloudflare Setup (10 stages) ---
  stageHeader(2, 'Authenticating with Cloudflare');
  let whoami = run(bin('wrangler'), ['whoami', '--json'], {
    dryRun,
    capture: true,
    allowFail: true,
    quiet: true,
  });
  if (!dryRun && whoami.status !== 0) {
    console.log('  not logged in — running `wrangler login` (opens your browser)');
    run(bin('wrangler'), ['login'], { dryRun });
    whoami = run(bin('wrangler'), ['whoami', '--json'], {
      capture: true,
      allowFail: true,
      quiet: true,
    });
    if (whoami.status !== 0) {
      console.error('  ❌ Cloudflare login did not complete. Verify with `pnpm exec wrangler whoami`.');
      process.exit(1);
    }
  } else {
    console.log(dryRun ? '  [dry-run] Verify Cloudflare authentication (`wrangler whoami --json`)' : '  wrangler: authenticated');
  }

  stageHeader(3, 'Selecting Cloudflare account');
  if (!dryRun) {
    const info = parseFirstJson(whoami.stdout ?? '');
    const accounts = collectAccounts(info);
    const accountSelection = await resolveCloudflareAccount({
      accounts,
      envAccountId: process.env.CLOUDFLARE_ACCOUNT_ID,
      isInteractive: Boolean(process.stdin.isTTY),
      promptFn: async (available) => {
        console.log('  Multiple Cloudflare accounts found:');
        available.forEach((a, i) => console.log(`    [${i}] ${a.name ?? '(no name)'}  ${a.id}`));
        const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
        try {
          return await rl.question('  Select account index or id: ');
        } finally {
          rl.close();
        }
      },
    });
    if (!accountSelection.ok) {
      console.error(`  ❌ ${accountSelection.error}`);
      process.exit(1);
    }
    if (accountSelection.accountId) {
      process.env.CLOUDFLARE_ACCOUNT_ID = accountSelection.accountId;
      console.log(
        `  using account ${accountSelection.accountName ?? '(unnamed)'} (${accountSelection.accountId}) [${accountSelection.selectedBy}]`,
      );
    } else {
      console.log('  using default Wrangler session account');
    }
  } else {
    console.log('  [dry-run] Resolve CLOUDFLARE_ACCOUNT_ID / active Wrangler account');
  }

  stageHeader(4, 'Validating resource configuration');
  let remoteDbs = [];
  let remoteDbsLoaded = false;
  if (!dryRun) {
    const list = run(bin('wrangler'), ['d1', 'list', '--json'], {
      capture: true,
      allowFail: true,
      quiet: true,
    });
    if (list.status === 0) {
      remoteDbs = parseFirstJson(list.stdout) ?? [];
      remoteDbsLoaded = true;
    }
  }
  const resourceValidation = validateWranglerResourceConfig(profile.effectiveConfig, {
    envD1Id: profile.envD1Id,
    remoteDbs,
    remoteDbsLoaded,
  });
  if (!resourceValidation.ok) {
    for (const err of resourceValidation.errors) console.error(`  ❌ ${err}`);
    process.exit(1);
  }
  for (const warn of resourceValidation.warnings) console.warn(`  ⚠️  ${warn}`);
  console.log(
    `  installation mode: ${resourceValidation.mode === 'existing' ? 'Existing installation (safe upgrade / retry)' : 'Fresh installation'}`,
  );
  console.log(
    `  configured env="${profile.envName}", worker="${profile.workerName}", d1="${resourceValidation.dbName}"${resourceValidation.bucketName ? `, r2="${resourceValidation.bucketName}"` : ''}`,
  );

  stageHeader(5, 'Provisioning missing resources');
  const { d1Id, dbName, bucketName } = ensureCloudflareResources(
    dryRun,
    resourceValidation,
  );
  if (!dryRun && d1Id) {
    upsertEnvVar(path.join(root, '.env'), profile.d1EnvKey, d1Id);
  }
  const configArgs = dryRun ? [] : getWranglerConfigArgs({ d1IdOverride: d1Id, profile });

  stageHeader(6, 'Running database migrations');
  await migrateDatabase(target, {
    dryRun,
    configArgs,
    databaseName: dbName,
    allowPreBaselineReset: false,
  });

  stageHeader(7, 'Configuring secrets');
  let existingSecrets = [];
  let workerExists = false;
  if (!dryRun) {
    const secretListRes = run(
      bin('wrangler'),
      [...configArgs, 'secret', 'list', '--format', 'json', ...WRANGLER_ARGS],
      {
        capture: true,
        allowFail: true,
        quiet: true,
      },
    );
    if (secretListRes.status === 0) {
      workerExists = true;
      existingSecrets = parseFirstJson(secretListRes.stdout ?? '[]') ?? [];
      console.log(`  detected ${existingSecrets.length} existing secret(s) on Worker (preserving values)`);
    } else {
      console.log('  Worker does not exist yet; secrets will be uploaded right after initial deploy');
    }
  } else {
    console.log('  [dry-run] Inspect existing Worker secrets via `wrangler secret list --format json`');
    console.log('  [dry-run] Preserve existing secrets; upload only missing secrets via `wrangler secret bulk`');
  }

  stageHeader(8, 'Deploying application');
  run(bin('typescript', 'tsc'), ['-b'], { dryRun });
  run(bin('vite'), ['build'], { dryRun });
  const deployArgs = [...configArgs, 'deploy', ...WRANGLER_ARGS];
  if (domain && !domain.endsWith('.workers.dev')) deployArgs.push('--domains', domain);
  const deploy = run(bin('wrangler'), deployArgs, { dryRun, capture: true });
  const url = domain
    ? `https://${domain}`
    : (deploy.stdout.match(/https:\/\/[^\s]*workers\.dev[^\s]*/)?.[0] ?? null);
  if (!dryRun && !url) {
    console.error('  ❌ Could not determine the deployed URL from wrangler output.');
    process.exit(1);
  }
  const origin = url ?? (domain ? `https://${domain}` : 'https://<deployed-url>');
  console.log(`  deployed Worker assets & script to: ${origin}`);

  const originForAuth = domain ? `https://${domain}` : origin;
  const secretPlan = buildSecretPlan({
    existingSecrets,
    env: process.env,
    originForAuth,
    updateAuthUrl: Boolean(domain),
    rotateBootstrapToken,
  });

  if (!dryRun) {
    const keysToUpload = Object.keys(secretPlan.toUpload);
    if (keysToUpload.length === 0) {
      console.log(
        `  all required secrets already configured on Worker (preserved: ${secretPlan.preserved.join(', ')})`,
      );
    } else {
      const tmp = path.join(root, '.secrets.tmp.json');
      process.once('exit', () => fs.rmSync(tmp, { force: true }));
      fs.writeFileSync(tmp, JSON.stringify(secretPlan.toUpload, null, 2), { mode: 0o600 });
      try {
        console.log(`  uploading ${keysToUpload.length} missing/updated secret(s): ${keysToUpload.join(', ')}`);
        if (secretPlan.preserved.length > 0) {
          console.log(`  preserving existing secret(s): ${secretPlan.preserved.join(', ')}`);
        }
        const res = run(bin('wrangler'), [...configArgs, 'secret', 'bulk', tmp, ...WRANGLER_ARGS], {
          dryRun,
          allowFail: true,
        });
        if (res.status !== 0) {
          process.exit(1);
        }
      } finally {
        fs.rmSync(tmp, { force: true });
      }
    }
  } else {
    run(bin('wrangler'), ['secret', 'bulk', '.secrets.tmp.json', ...WRANGLER_ARGS], { dryRun });
  }

  stageHeader(9, 'Verifying deployment');
  if (dryRun) {
    console.log(`  [dry-run] GET ${origin}/api/health`);
    console.log(`  [dry-run] GET ${origin}/api/auth/config`);
    console.log(`  [dry-run] GET ${origin}/api/system/version`);
    console.log(`  [dry-run] GET ${origin}/ (SPA HTML check)`);
  } else {
    const verification = await verifyDeployment(origin, { attempts: 10, delayMs: 3000 });
    if (!verification.ok) {
      console.error(
        '  ❌ Worker deployment uploaded, but post-deploy application verification failed.',
      );
      if (secretPlan.generatedBootstrapToken) {
        console.error(
          `  ℹ️  Your generated BOOTSTRAP_TOKEN was uploaded to the Worker: ${secretPlan.generatedBootstrapToken}`,
        );
      }
      process.exit(1);
    }
  }

  stageHeader(10, 'Displaying application URL and next steps');
  console.log('\n======================================================');
  console.log(
    profile.isStaging
      ? '✅ Remote Cloudflare Staging Setup complete!'
      : profile.isDemo
        ? '✅ Remote Cloudflare Demo Setup complete!'
        : '✅ Remote Cloudflare Setup complete!',
  );
  console.log(
    `  Mode:               ${resourceValidation.mode === 'existing' || workerExists ? 'Existing installation (upgrade / retry)' : 'Fresh installation'}`,
  );
  console.log(
    `  ${profile.isStaging ? 'Staging URL:       ' : profile.isDemo ? 'Demo URL:          ' : 'Production URL:    '} ${origin}`,
  );
  console.log(`  D1 Database:        ${dbName} (${d1Id})`);
  if (bucketName) {
    console.log(`  R2 Bucket:          ${bucketName}`);
  }
  console.log(`  BETTER_AUTH_URL:    ${originForAuth}`);
  console.log(
    `  BETTER_AUTH_SECRET: ${secretPlan.toUpload.BETTER_AUTH_SECRET ? '[configured]' : '[preserved existing secret on Worker]'}`,
  );
  if (secretPlan.generatedBootstrapToken) {
    console.log(`  BOOTSTRAP_TOKEN:    ${secretPlan.generatedBootstrapToken}`);
  } else if (secretPlan.preserved.includes('BOOTSTRAP_TOKEN')) {
    console.log(
      '  BOOTSTRAP_TOKEN:    [preserved existing secret on Worker — pass --rotate-bootstrap-token to rotate]',
    );
  } else {
    console.log(
      '  Initial Owner:      First account registered at /login claims Owner (then locks to invite-only)',
    );
  }
  console.log('======================================================\n');
  if (secretPlan.generatedBootstrapToken) {
    console.log(
      'Next step: Open the Production URL above and register the initial Owner account with BOOTSTRAP_TOKEN.',
    );
  } else if (secretPlan.preserved.includes('BOOTSTRAP_TOKEN')) {
    console.log('Next step: Open the Production URL above to verify your upgraded instance.');
  } else {
    console.log(
      'Next step: Open the Production URL above and create your account at /login to claim Owner access.',
    );
  }
}

function ensureCloudflareResources(dryRun, validation) {
  const { dbName, bucketName, d1Id: discoveredId } = validation;

  if (bucketName) {
    if (dryRun) {
      run(bin('wrangler'), ['r2', 'bucket', 'create', bucketName], { dryRun });
    } else {
      const r2List = run(bin('wrangler'), ['r2', 'bucket', 'list'], {
        capture: true,
        allowFail: true,
        quiet: true,
      });
      const bucketExists =
        r2List.status === 0 && new RegExp(`\\b${bucketName}\\b`).test(r2List.stdout ?? '');
      if (bucketExists) {
        console.log(`  R2 bucket "${bucketName}" already exists (reusing)`);
      } else {
        const created = run(bin('wrangler'), ['r2', 'bucket', 'create', bucketName], {
          capture: true,
          allowFail: true,
          quiet: true,
        });
        if (
          created.status === 0 ||
          /already exists/i.test((created.stdout ?? '') + (created.stderr ?? ''))
        ) {
          console.log(`  R2 bucket "${bucketName}" ready`);
        } else {
          console.error(
            `  ❌ Failed to create R2 bucket "${bucketName}": ${created.stderr || created.stdout}`,
          );
          process.exit(1);
        }
      }
    }
  }

  if (dryRun) {
    run(bin('wrangler'), ['d1', 'create', dbName], { dryRun });
    return { d1Id: 'pending-d1-uuid', dbName, bucketName };
  }

  if (discoveredId) {
    console.log(`  D1 database "${dbName}" found on Cloudflare: ${discoveredId} (reusing)`);
    return { d1Id: discoveredId, dbName, bucketName };
  }

  const out = run(bin('wrangler'), ['d1', 'create', dbName], {
    capture: true,
    allowFail: true,
    quiet: true,
  });
  let resolvedId = /database_id[:\s"]+([0-9a-f-]{36})/i.exec(out.stdout)?.[1];
  if (!resolvedId) {
    const retryList = run(bin('wrangler'), ['d1', 'list', '--json'], {
      capture: true,
      quiet: true,
    });
    const dbs = parseFirstJson(retryList.stdout) ?? [];
    const found = dbs.find((d) => d.database_name === dbName || d.name === dbName);
    if (!found) {
      console.error('  ❌ Could not create or locate the D1 database.');
      if (out.stderr) console.error(out.stderr);
      process.exit(1);
    }
    resolvedId = found.uuid ?? found.database_id;
  }
  console.log(`  provisioned D1 database "${dbName}": ${resolvedId}`);
  return { d1Id: resolvedId, dbName, bucketName };
}

main().catch((err) => {
  console.error('\n❌ Setup failed:', err instanceof Error ? err.message : err);
  process.exit(1);
});

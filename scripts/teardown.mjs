#!/usr/bin/env node
/**
 * Completely tear down Burrow resources.
 *
 * Targets:
 *   (default)              Local cleanup (removes ./data and ./dist only)
 *   --remote, --r, -r      Remote Cloudflare teardown (permanently deletes Worker, D1, R2 on Cloudflare)
 *
 * Flags:
 *   --staging                        Target isolated staging resources (burrow-staging)
 *   --force                          Bypass interactive confirmation on staging (blocked on production unless confirmed)
 *   --confirm-production-teardown    Must equal DELETE-PRODUCTION-BURROW when tearing down production with --force
 */
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline/promises';
import {
  assertProductionOperationAllowed,
  bin,
  hasFlag,
  isRemoteTarget,
  loadEnv,
  parseCliArgs,
  parseJsonc,
  printTargetBanner,
  resolveRemoteProfile,
  root,
  run,
  step,
  upsertEnvVar,
} from './lib.mjs';

parseCliArgs(process.argv.slice(2));
const isRemote = isRemoteTarget();
const force = hasFlag('--force');

function readWranglerConfig() {
  const configPath = path.join(root, 'wrangler.jsonc');
  if (!fs.existsSync(configPath)) return {};
  try {
    return parseJsonc(fs.readFileSync(configPath, 'utf8'));
  } catch {
    return {};
  }
}

async function main() {
  loadEnv();
  const profile = isRemote ? resolveRemoteProfile(readWranglerConfig()) : null;
  printTargetBanner('Teardown', isRemote, { profile });

  if (!isRemote) {
    step('Cleaning local development state (removing ./data and ./dist only)');
    const distDir = path.join(root, 'dist');
    if (fs.existsSync(distDir)) {
      fs.rmSync(distDir, { recursive: true, force: true });
      console.log('  Removed dist/ build directory');
    }
    const dataDir = path.join(root, 'data');
    try {
      if (fs.existsSync(dataDir)) {
        fs.rmSync(dataDir, { recursive: true, force: true });
        console.log('  Removed data/ directory (local SQLite database, Miniflare state & uploads)');
      }
    } catch (err) {
      console.warn(`  Could not remove data/ (file locked by active server): ${err.message}`);
    }
    console.log('\n======================================================');
    console.log('✅ Local cleanup complete. ./data and ./dist removed.');
    console.log('Run `pnpm dev` or `pnpm run reset` to initialize fresh.');
    console.log('To tear down remote Cloudflare production resources, run:');
    console.log('  pnpm run teardown -r\n');
    console.log('======================================================\n');
    return;
  }

  const workerName = profile.workerName;
  const dbName = profile.dbName;
  const bucketName = profile.bucketName;

  // --- Remote Cloudflare Teardown ---
  console.log('======================================================');
  console.log(
    profile.isStaging
      ? '⚠️  WARNING: CLOUDFLARE STAGING RESOURCE TEARDOWN'
      : '🚨 DANGER: CLOUDFLARE PRODUCTION RESOURCE TEARDOWN',
  );
  console.log('======================================================');
  console.log(
    `This will PERMANENTLY delete the following ${profile.isStaging ? 'STAGING' : 'PRODUCTION'} resources:`,
  );
  console.log(`  1. Cloudflare Worker: "${workerName}"`);
  console.log(`  2. Cloudflare D1 Database: "${dbName}" (and all data)`);
  if (bucketName) {
    console.log(`  3. Cloudflare R2 Bucket: "${bucketName}" (and all files)`);
  }
  console.log('======================================================\n');

  if (!profile.isStaging) {
    const auth = assertProductionOperationAllowed({
      operation: 'teardown',
      profile,
      args: process.argv.slice(2),
      env: process.env,
      isInteractive: Boolean(process.stdin.isTTY),
    });
    if (auth.mode === 'interactive') {
      const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
      const confirmPhrase = await rl.question(
        'Type "TEARDOWN-PRODUCTION" to confirm deleting production resources: ',
      );
      if (confirmPhrase.trim() !== 'TEARDOWN-PRODUCTION') {
        rl.close();
        console.log('Teardown cancelled. No resources were modified.');
        process.exit(0);
      }
      const confirmName = await rl.question(
        `Type the exact Worker name ("${workerName}") to permanently delete it: `,
      );
      rl.close();
      if (confirmName.trim() !== workerName) {
        console.log('Worker name mismatch. Teardown cancelled. No resources were modified.');
        process.exit(0);
      }
    }
  } else if (!force) {
    if (!process.stdin.isTTY) {
      throw new Error(
        `Refusing non-interactive staging teardown on "${workerName}" without --force.`,
      );
    }
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    const answer = await rl.question(
      'Type "TEARDOWN-STAGING" to confirm deleting staging resources: ',
    );
    rl.close();

    if (answer.trim() !== 'TEARDOWN-STAGING') {
      console.log('Teardown cancelled. No resources were modified.');
      process.exit(0);
    }
  }

  // 1. Delete Cloudflare Worker
  step(`Deleting Cloudflare Worker ("${workerName}")`);
  run(bin('wrangler'), ['delete', workerName, '--force'], { allowFail: true });

  // 2. Delete Cloudflare D1 Database
  step(`Deleting Cloudflare D1 Database ("${dbName}")`);
  run(bin('wrangler'), ['d1', 'delete', dbName, '--skip-confirmation'], { allowFail: true });

  // 3. Delete Cloudflare R2 Bucket
  if (bucketName) {
    step(`Deleting Cloudflare R2 Bucket ("${bucketName}")`);
    run(bin('wrangler'), ['r2', 'bucket', 'delete', bucketName], { allowFail: true });
  }

  // Clean local ephemeral Wrangler config and D1 UUID
  const localWranglerPath = path.join(root, profile.localConfigFilename);
  if (fs.existsSync(localWranglerPath)) {
    fs.rmSync(localWranglerPath, { force: true });
    console.log(`  Removed ephemeral ${profile.localConfigFilename}`);
  }
  const envPath = path.join(root, '.env');
  if (upsertEnvVar(envPath, profile.d1EnvKey, '')) {
    console.log(`  Cleared ${profile.d1EnvKey} in .env`);
  }
  const distDir = path.join(root, 'dist');
  if (fs.existsSync(distDir)) {
    fs.rmSync(distDir, { recursive: true, force: true });
  }
  if (!profile.isStaging) {
    const dataDir = path.join(root, 'data');
    if (fs.existsSync(dataDir)) {
      fs.rmSync(dataDir, { recursive: true, force: true });
    }
  }

  console.log('\n======================================================');
  console.log(`✅ Remote ${profile.envName} teardown complete.`);
  console.log('======================================================\n');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

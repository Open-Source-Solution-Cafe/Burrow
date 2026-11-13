#!/usr/bin/env node
/**
 * Reset Burrow resources back to a clean initial default state.
 *
 * Targets:
 *   (default)              Local SQLite database (./data/burrow.db) and uploads (./data/uploads)
 *   --worker               Local Worker/D1 and R2 persisted under ./data
 *   --remote, --r, -r      Remote Cloudflare D1 database (requires confirmation phrase)
 *
 * Flags:
 *   --staging                  Target isolated staging resources (burrow-staging)
 *   --force                    Bypass interactive confirmation on staging (requires --confirm-production-reset on production)
 *   --confirm-production-reset Must equal RESET-PRODUCTION-BURROW when resetting production with --force
 */
import readline from 'node:readline/promises';
import fs from 'node:fs';
import path from 'node:path';
import { assertResetDirectory } from '../src/server/database-target.ts';
import {
  assertProductionOperationAllowed,
  bin,
  hasFlag,
  getDatabaseTarget,
  migrateDatabase,
  parseCliArgs,
  parseJsonc,
  printTargetBanner,
  resolveRemoteProfile,
  root,
  run,
  step,
  getWranglerConfigArgs,
} from './lib.mjs';

parseCliArgs(process.argv.slice(2));
const target = getDatabaseTarget();
const isRemote = target.kind === 'remote';
const force = hasFlag('--force');
const baseCfg = parseJsonc(fs.readFileSync(path.join(root, 'wrangler.jsonc'), 'utf8'));
const profile = isRemote ? resolveRemoteProfile(baseCfg) : null;

const cleanSql = [
  "INSERT OR IGNORE INTO bootstrap_state (id, status) VALUES (1, 'empty');",
  "UPDATE bootstrap_state SET status = 'empty', claim_email = NULL, user_id = NULL, workspace_id = NULL WHERE id = 1;",
  'DELETE FROM notepads_fts;',
  'DELETE FROM project_files;',
  'DELETE FROM card_subtasks;',
  'DELETE FROM card_comments;',
  'DELETE FROM card_assignees;',
  'DELETE FROM cards;',
  'DELETE FROM board_columns;',
  'DELETE FROM boards;',
  'DELETE FROM notepad_tags;',
  'DELETE FROM notepad_links;',
  'DELETE FROM edit_locks;',
  'DELETE FROM notepads;',
  'DELETE FROM tags;',
  'DELETE FROM projects;',
  'DELETE FROM invites;',
  'DELETE FROM notifications;',
  'DELETE FROM members;',
  'DELETE FROM workspaces;',
  'DELETE FROM session;',
  'DELETE FROM account;',
  'DELETE FROM verification;',
  'DELETE FROM user;',
].join(' ');

async function main() {
  printTargetBanner('Reset Database', target, { profile });

  if (!isRemote) {
    if (target.kind === 'node') {
      assertResetDirectory(target.storagePath, root);
      step(`Resetting local SQLite database (${target.sqlitePath})`);
      for (const suffix of ['', '-wal', '-shm']) {
        fs.rmSync(`${target.sqlitePath}${suffix}`, { force: true });
      }
      step(`Clearing local uploads (${target.storagePath})`);
      fs.rmSync(target.storagePath, { recursive: true, force: true });
      fs.mkdirSync(target.storagePath, { recursive: true });
    } else {
      const workerDir = path.join(target.persistTo, 'v3');
      assertResetDirectory(workerDir, root);
      step(`Clearing local Worker persistence (${workerDir})`);
      fs.rmSync(workerDir, { recursive: true, force: true });
    }
    step('Applying migrations to the selected local database');
    await migrateDatabase(target, { allowPreBaselineReset: true });

    step('Rebuilding server and web bundle (pnpm run build)');
    run('pnpm', ['run', 'build'], { allowFail: false });

    console.log('\n======================================================');
    console.log('✅ Local database and storage have been reset to clean default state.');
    console.log('Server and web assets rebuilt.');
    console.log('Ready for fresh bootstrap owner registration.');
    console.log('======================================================\n');
    return;
  }

  // --- Remote Cloudflare D1 Reset ---
  const targetName = profile.isStaging
    ? `REMOTE Cloudflare Staging (${profile.dbName})`
    : `REMOTE Cloudflare Production (${profile.dbName})`;

  const auth = assertProductionOperationAllowed({
    operation: 'reset',
    profile,
    args: process.argv.slice(2),
    env: process.env,
    isInteractive: Boolean(process.stdin.isTTY),
  });

  if (auth.mode === 'interactive' || (profile.isStaging && !force)) {
    if (!process.stdin.isTTY) {
      throw new Error(
        `Refusing non-interactive staging reset on "${profile.dbName}" without --force.`,
      );
    }
    console.log('======================================================');
    console.log(`⚠️  DANGER: RESET ${targetName} DATABASE`);
    console.log('======================================================');
    console.log(`This will WIPE ALL DATA from remote Cloudflare D1 database "${profile.dbName}":`);
    console.log('  - All users, accounts, sessions, and workspaces');
    console.log('  - All projects, boards, cards, and notepads');
    console.log('  - Returns the database to a completely clean, initial slate.');
    console.log('======================================================\n');

    const expectedPhrase = profile.isStaging ? 'RESET-STAGING' : 'RESET-PRODUCTION';
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    const answer = await rl.question(
      `Type "${expectedPhrase}" to confirm resetting ${profile.envName}: `,
    );
    rl.close();

    if (answer.trim() !== expectedPhrase) {
      console.log('Reset cancelled. No data was modified.');
      process.exit(0);
    }
  }

  const configArgs = getWranglerConfigArgs({
    required: true,
    purpose: 'remote database reset',
    profile,
  });

  step(`Ensuring migrations are applied on ${targetName} D1 database`);
  await migrateDatabase(target, {
    configArgs,
    databaseName: profile.dbName,
    allowPreBaselineReset: true,
  });

  step(`Cleaning all records from ${targetName} D1 database`);
  run(
    bin('wrangler'),
    [...configArgs, 'd1', 'execute', profile.dbName, '--remote', `--command=${cleanSql}`],
    { allowFail: false },
  );

  step('Verifying database is clean (0 users, 0 workspaces)');
  run(
    bin('wrangler'),
    [
      ...configArgs,
      'd1',
      'execute',
      profile.dbName,
      '--remote',
      '--command=SELECT count(*) AS user_count FROM user; SELECT count(*) AS workspace_count FROM workspaces;',
    ],
    { allowFail: false },
  );

  console.log('\n======================================================');
  console.log(`✅ ${targetName} database has been reset to clean default state.`);
  console.log('Ready for fresh bootstrap owner registration.');
  console.log('======================================================\n');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

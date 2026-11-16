#!/usr/bin/env node
/**
 * Reset & Seed Burrow for Demo Environments (e.g. burrow.osscafe.com).
 * Wipes data, inserts fresh interactive demo data + demo credentials,
 * and verifies that all database invariants hold.
 *
 * Targets:
 *   (default)              Local SQLite database
 *   --worker               Local Worker/D1
 *   --remote, --r, -r      Remote Cloudflare D1 database
 *
 * Flags:
 *   --force                Bypass confirmation prompt on remote
 *   --email <email>        Demo user email (default: DEMO_EMAIL env or demo@osscafe.com)
 *   --password <password>  Demo user password (default: DEMO_PASSWORD env or demopassword123)
 */
import readline from 'node:readline/promises';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { hashPassword } from 'better-auth/crypto';
import { assertResetDirectory, selectDatabaseTarget } from '../src/server/database-target.ts';
import {
  assertDemoResetAllowed,
  bin,
  collectAccounts,
  inspectOrCleanRemoteR2References,
  loadEnv,
  migrateDatabase,
  parseCliArgs,
  parseFirstJson,
  parseJsonc,
  printTargetBanner,
  resolveRemoteProfile,
  root,
  run,
  step,
  getWranglerConfigArgs,
  executeDatabaseFile,
} from './lib.mjs';

const EMAIL_REGEX = /^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$/;
const ACCOUNT_ID_REGEX = /^[a-f0-9]{32}$/i;
const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function validateDemoEmail(email) {
  const trimmed = String(email ?? '').trim();
  if (!trimmed || trimmed.length > 254 || !EMAIL_REGEX.test(trimmed)) {
    throw new Error(`Invalid DEMO_EMAIL "${trimmed}": must be a plain RFC email address without quotes or whitespace.`);
  }
  return trimmed;
}

function escapeSqlLiteral(value) {
  return String(value).replace(/'/g, "''");
}

function assertExpectedDemoTargetConfig(baseCfg, profile, env, rootDir) {
  const demoSection = baseCfg?.env?.demo;
  if (!demoSection || typeof demoSection !== 'object') {
    throw new Error(
      'Missing explicit env.demo deployment target in wrangler.jsonc. Ordinary production deployments cannot be reset by demo-reset.',
    );
  }
  const sectionWorker = demoSection.name;
  const sectionDb = demoSection.d1_databases?.[0]?.database_name;
  const sectionBucket = demoSection.r2_buckets?.[0]?.bucket_name;
  if (
    !sectionWorker ||
    sectionWorker === baseCfg?.name ||
    !sectionDb ||
    sectionDb === baseCfg?.d1_databases?.[0]?.database_name ||
    !sectionBucket ||
    sectionBucket === baseCfg?.r2_buckets?.[0]?.bucket_name
  ) {
    throw new Error(
      'Invalid env.demo configuration in wrangler.jsonc: demo target resources must be distinct from production resources.',
    );
  }

  const accountId = env.DEMO_CLOUDFLARE_ACCOUNT_ID?.trim() || '';
  if (!ACCOUNT_ID_REGEX.test(accountId)) {
    throw new Error(
      'Missing or invalid DEMO_CLOUDFLARE_ACCOUNT_ID: remote demo reset requires a 32-character Cloudflare account ID.',
    );
  }
  const ambientAccountId = env.CLOUDFLARE_ACCOUNT_ID?.trim();
  if (ambientAccountId && ambientAccountId.toLowerCase() !== accountId.toLowerCase()) {
    throw new Error(
      `Account target mismatch: CLOUDFLARE_ACCOUNT_ID (${ambientAccountId}) does not match DEMO_CLOUDFLARE_ACCOUNT_ID (${accountId}).`,
    );
  }

  const workerName = env.DEMO_WORKER_NAME?.trim() || '';
  if (!workerName || workerName !== profile.workerName) {
    throw new Error(
      `Missing or mismatched DEMO_WORKER_NAME ("${workerName}"): expected "${profile.workerName}".`,
    );
  }

  const databaseName = env.DEMO_D1_DATABASE_NAME?.trim() || '';
  if (!databaseName || databaseName !== profile.dbName) {
    throw new Error(
      `Missing or mismatched DEMO_D1_DATABASE_NAME ("${databaseName}"): expected "${profile.dbName}".`,
    );
  }

  const databaseId = env.DEMO_D1_DATABASE_ID?.trim() || '';
  if (!UUID_REGEX.test(databaseId)) {
    throw new Error(
      'Missing or invalid DEMO_D1_DATABASE_ID: remote demo reset requires an explicit 36-character D1 database UUID.',
    );
  }

  const bucketName = env.DEMO_R2_BUCKET_NAME?.trim() || '';
  if (!bucketName || bucketName !== profile.bucketName) {
    throw new Error(
      `Missing or mismatched DEMO_R2_BUCKET_NAME ("${bucketName}"): expected "${profile.bucketName}".`,
    );
  }

  const localDemoConfigPath = path.join(rootDir, profile.localConfigFilename);
  if (fs.existsSync(localDemoConfigPath)) {
    const localCfg = parseJsonc(fs.readFileSync(localDemoConfigPath, 'utf8'));
    const localWorker = localCfg?.name;
    const localDb = localCfg?.d1_databases?.[0]?.database_name;
    const localDbId = localCfg?.d1_databases?.[0]?.database_id;
    const localBucket = localCfg?.r2_buckets?.[0]?.bucket_name;
    if (
      (localWorker && localWorker !== workerName) ||
      (localDb && localDb !== databaseName) ||
      (localDbId && localDbId.toLowerCase() !== databaseId.toLowerCase()) ||
      (localBucket && localBucket !== bucketName)
    ) {
      throw new Error(
        `Existing ${profile.localConfigFilename} conflicts with explicit demo target configuration (worker=${localWorker}, db=${localDb}/${localDbId}, bucket=${localBucket}).`,
      );
    }
  }

  return {
    accountId: accountId.toLowerCase(),
    workerName,
    databaseName,
    databaseId: databaseId.toLowerCase(),
    bucketName,
  };
}

export function resolveDemoResetContext({
  args = process.argv.slice(2),
  env = process.env,
  isInteractive = Boolean(process.stdin.isTTY),
  rootDir = root,
} = {}) {
  const parsed = parseCliArgs(args);
  const target = selectDatabaseTarget(args, env, rootDir);
  const isRemote = target.kind === 'remote';
  const baseCfg = parseJsonc(fs.readFileSync(path.join(rootDir, 'wrangler.jsonc'), 'utf8'));

  let profile = null;
  let expectedTarget = null;
  if (isRemote) {
    const isExplicitDemoFlag =
      parsed.booleanFlags['--demo'] === true || parsed.values['--env'] === 'demo';
    const confirmWorker = parsed.values['--confirm'];
    if (!isExplicitDemoFlag && !confirmWorker) {
      throw new Error(
        'Refusing remote demo reset without explicit --demo flag (--env=demo) or --confirm=<worker-name>. Ordinary production deployments cannot be reset without targeting the explicit demo environment.',
      );
    }
    profile = resolveRemoteProfile(baseCfg, { args, env });
    if (!isExplicitDemoFlag && confirmWorker !== profile.workerName) {
      throw new Error(
        `Refusing remote demo reset: --confirm="${confirmWorker}" does not match target Worker "${profile.workerName}".`,
      );
    }
    assertDemoResetAllowed({ profile, args, env, isInteractive });
    expectedTarget = isExplicitDemoFlag
      ? assertExpectedDemoTargetConfig(baseCfg, profile, env, rootDir)
      : null;
  }

  const demoEmail = validateDemoEmail(parsed.values['--email'] || env.DEMO_EMAIL || 'demo@osscafe.com');
  const demoPassword = parsed.values['--password'] || env.DEMO_PASSWORD || 'demopassword123';
  return {
    target,
    isRemote,
    profile,
    expectedTarget,
    demoEmail,
    demoPassword,
    cleanR2: parsed.booleanFlags['--clean-r2'] === true,
  };
}

/**
 * Verify exact remote Cloudflare account, D1 database, Worker script, and R2 bucket
 * via Wrangler before executing any destructive remote operation.
 */
export function verifyRemoteDemoResources({
  expectedTarget,
  runFn = run,
  wranglerBin = bin('wrangler'),
}) {
  if (!expectedTarget) {
    throw new Error('Missing expected demo target metadata for remote resource validation.');
  }
  const scopedEnv = { CLOUDFLARE_ACCOUNT_ID: expectedTarget.accountId };

  // 1. Validate Cloudflare account in active session
  const whoamiRes = runFn(wranglerBin, ['whoami', '--json'], {
    capture: true,
    allowFail: true,
    quiet: true,
    env: scopedEnv,
  });
  if (whoamiRes.status !== 0) {
    throw new Error(
      `Failed to verify Cloudflare account via Wrangler whoami: ${whoamiRes.stderr || whoamiRes.stdout || 'unknown error'}`,
    );
  }
  const whoamiJson = parseFirstJson(whoamiRes.stdout);
  const accounts = collectAccounts(whoamiJson);
  const accountMatch = accounts.find(
    (a) => a.id.toLowerCase() === expectedTarget.accountId.toLowerCase(),
  );
  if (!accountMatch) {
    throw new Error(
      `Cloudflare account mismatch: expected DEMO_CLOUDFLARE_ACCOUNT_ID (${expectedTarget.accountId}) is not authorized in active Wrangler session.`,
    );
  }

  // 2. Validate exact remote D1 database UUID & name on that account
  const d1Res = runFn(wranglerBin, ['d1', 'list', '--json'], {
    capture: true,
    allowFail: true,
    quiet: true,
    env: scopedEnv,
  });
  if (d1Res.status !== 0) {
    throw new Error(
      `Failed to inspect remote D1 databases via Wrangler: ${d1Res.stderr || d1Res.stdout || 'unknown error'}`,
    );
  }
  const dbs = parseFirstJson(d1Res.stdout);
  if (!Array.isArray(dbs)) {
    throw new Error('Invalid JSON response from `wrangler d1 list --json`.');
  }
  const byId = dbs.filter(
    (d) => d && (d.uuid ?? d.database_id ?? '').toLowerCase() === expectedTarget.databaseId,
  );
  const byName = dbs.filter(
    (d) => d && (d.name ?? d.database_name) === expectedTarget.databaseName,
  );
  if (byId.length !== 1 || byName.length !== 1) {
    throw new Error(
      `Remote D1 verification failed for "${expectedTarget.databaseName}" (${expectedTarget.databaseId}): found ${byId.length} match(es) by UUID and ${byName.length} match(es) by name.`,
    );
  }
  const matchedDbName = byId[0].name ?? byId[0].database_name;
  const matchedDbId = (byName[0].uuid ?? byName[0].database_id ?? '').toLowerCase();
  if (matchedDbName !== expectedTarget.databaseName || matchedDbId !== expectedTarget.databaseId) {
    throw new Error(
      `Remote D1 mismatch: UUID ${expectedTarget.databaseId} belongs to "${matchedDbName}", while "${expectedTarget.databaseName}" has UUID ${matchedDbId}.`,
    );
  }

  // 3. Validate exact remote Worker script exists on the verified account
  const deployRes = runFn(
    wranglerBin,
    ['deployments', 'list', '--name', expectedTarget.workerName, '--json'],
    {
      capture: true,
      allowFail: true,
      quiet: true,
      env: scopedEnv,
    },
  );
  if (deployRes.status !== 0) {
    throw new Error(
      `Remote Worker "${expectedTarget.workerName}" verification failed: ${deployRes.stderr || deployRes.stdout || 'not found'}`,
    );
  }
  const deployments = parseFirstJson(deployRes.stdout);
  if (!Array.isArray(deployments) || deployments.length === 0) {
    throw new Error(
      `Remote Worker "${expectedTarget.workerName}" has no active deployments on account ${expectedTarget.accountId}.`,
    );
  }

  // 4. Validate exact remote R2 bucket exists on the verified account
  const r2Res = runFn(
    wranglerBin,
    ['r2', 'bucket', 'info', expectedTarget.bucketName, '--json'],
    {
      capture: true,
      allowFail: true,
      quiet: true,
      env: scopedEnv,
    },
  );
  if (r2Res.status !== 0) {
    throw new Error(
      `Remote R2 bucket "${expectedTarget.bucketName}" verification failed: ${r2Res.stderr || r2Res.stdout || 'not found'}`,
    );
  }
  const bucketInfo = parseFirstJson(r2Res.stdout);
  if (bucketInfo && typeof bucketInfo === 'object' && bucketInfo.name && bucketInfo.name !== expectedTarget.bucketName) {
    throw new Error(
      `Remote R2 bucket mismatch: expected "${expectedTarget.bucketName}", got "${bucketInfo.name}".`,
    );
  }

  return {
    accountId: accountMatch.id,
    workerName: expectedTarget.workerName,
    databaseName: expectedTarget.databaseName,
    databaseId: expectedTarget.databaseId,
    bucketName: expectedTarget.bucketName,
  };
}

const cleanSql = [
  "INSERT OR IGNORE INTO bootstrap_state (id, status) VALUES (1, 'empty');",
  "UPDATE bootstrap_state SET status = 'empty', claim_email = NULL, user_id = NULL, workspace_id = NULL WHERE id = 1;",
  'DELETE FROM notepads_fts;',
  'DELETE FROM pending_storage_deletions;',
  'DELETE FROM rate_limits;',
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

export function buildDemoSeedSql(passwordHash, email) {
  const safeEmail = escapeSqlLiteral(validateDemoEmail(email));
  const safeHash = escapeSqlLiteral(passwordHash);
  const now = Date.now();
  return `
-- 1. Demo Users
INSERT INTO user (id, name, email, emailVerified, createdAt, updatedAt)
VALUES
  ('usr_demo', 'Demo User', '${safeEmail}', 1, ${now}, ${now}),
  ('usr_alice', 'Alice Smith', 'alice@osscafe.com', 1, ${now}, ${now}),
  ('usr_bob', 'Bob Jones', 'bob@osscafe.com', 1, ${now}, ${now});

-- 2. Account (Credentials Provider for Demo Login)
INSERT INTO account (id, accountId, providerId, userId, password, createdAt, updatedAt)
VALUES
  ('acc_demo', 'usr_demo', 'credential', 'usr_demo', '${safeHash}', ${now}, ${now});

-- 3. Workspace
INSERT INTO workspaces (id, name, created_by, created_at)
VALUES ('ws_demo_acme', 'OSSCafe Demo Workspace', 'usr_demo', ${now});

-- 4. Mark Bootstrap Complete
INSERT OR REPLACE INTO bootstrap_state (id, status, claim_email, user_id, workspace_id)
VALUES (1, 'complete', '${safeEmail}', 'usr_demo', 'ws_demo_acme');

-- 5. Members
INSERT INTO members (workspace_id, user_id, role, joined_at)
VALUES
  ('ws_demo_acme', 'usr_demo', 'owner', ${now}),
  ('ws_demo_acme', 'usr_alice', 'editor', ${now}),
  ('ws_demo_acme', 'usr_bob', 'editor', ${now});

-- 6. Projects
INSERT INTO projects (id, workspace_id, name, icon, color, position, created_at, updated_at)
VALUES
  ('proj_prod', 'ws_demo_acme', 'Product & Engineering', '🚀', '#8b5cf6', 'a0', ${now}, ${now}),
  ('proj_design', 'ws_demo_acme', 'Design & UX', '🎨', '#ec4899', 'a1', ${now}, ${now});

-- 7. Tags
INSERT INTO tags (id, project_id, name, color)
VALUES
  ('tag_roadmap', 'proj_prod', 'roadmap', '#8b5cf6'),
  ('tag_arch', 'proj_prod', 'architecture', '#3b82f6'),
  ('tag_design', 'proj_design', 'ui', '#ec4899');

-- 8. Notepads
INSERT INTO notepads (id, workspace_id, project_id, parent_id, kind, title, icon, content, version, position, is_favorite, created_by, created_at, updated_at)
VALUES
  ('np_welcome', 'ws_demo_acme', 'proj_prod', NULL, 'notepad', 'Welcome to Burrow (Demo Instance)', '👋', '[{"type":"paragraph","content":[{"type":"text","text":"Welcome to the OSSCafe demo instance of Burrow! This demo environment is reset automatically every 2 hours. Feel free to create boards, add tasks, drag and drop cards, and write rich notepads."}]}]', 1, 'a0', 1, 'usr_demo', ${now}, ${now}),
  ('np_roadmap', 'ws_demo_acme', 'proj_prod', NULL, 'notepad', 'Q4 Product Roadmap', '🗺️', '[{"type":"paragraph","content":[{"type":"text","text":"High-level deliverables for the final quarter including real-time sync and full-text search."}]}]', 1, 'a1', 1, 'usr_demo', ${now}, ${now}),
  ('np_arch', 'ws_demo_acme', 'proj_prod', 'np_roadmap', 'notepad', 'Edge Architecture Review', '⚡', '[{"type":"paragraph","content":[{"type":"text","text":"Moving state to the edge with Cloudflare Workers and D1 database."}]}]', 1, 'a0', 0, 'usr_alice', ${now}, ${now}),
  ('np_design', 'ws_demo_acme', 'proj_design', NULL, 'notepad', 'Design System Guidelines', '✨', '[{"type":"paragraph","content":[{"type":"text","text":"Typography, spacing, colors, and accessibility tokens."}]}]', 1, 'a0', 1, 'usr_bob', ${now}, ${now});

-- 9. FTS for Notepads
INSERT INTO notepads_fts (notepad_id, project_id, title, body)
VALUES
  ('np_welcome', 'proj_prod', 'Welcome to Burrow (Demo Instance)', 'Welcome to the OSSCafe demo instance of Burrow! This demo environment is reset automatically every 2 hours. Feel free to create boards, add tasks, drag and drop cards, and write rich notepads.'),
  ('np_roadmap', 'proj_prod', 'Q4 Product Roadmap', 'High-level deliverables for the final quarter including real-time sync and full-text search.'),
  ('np_arch', 'proj_prod', 'Edge Architecture Review', 'Moving state to the edge with Cloudflare Workers and D1 database.'),
  ('np_design', 'proj_design', 'Design System Guidelines', 'Typography, spacing, colors, and accessibility tokens.');

-- 10. Notepad Tags
INSERT INTO notepad_tags (notepad_id, tag_id)
VALUES
  ('np_roadmap', 'tag_roadmap'),
  ('np_arch', 'tag_arch'),
  ('np_design', 'tag_design');

-- 11. Kanban Board & Columns
INSERT INTO boards (id, workspace_id, project_id, name, icon, position, created_at, updated_at)
VALUES ('board_sprint', 'ws_demo_acme', 'proj_prod', 'Sprint 42 Board', '📋', 'a0', ${now}, ${now});

INSERT INTO board_columns (id, board_id, name, position)
VALUES
  ('col_todo', 'board_sprint', 'To do', 'a0'),
  ('col_inprog', 'board_sprint', 'In progress', 'a1'),
  ('col_done', 'board_sprint', 'Done', 'a2');

-- 12. Cards & Card Notepads
INSERT INTO notepads (id, workspace_id, project_id, parent_id, kind, title, icon, content, version, position, is_favorite, created_by, created_at, updated_at)
VALUES
  ('np_card_1', 'ws_demo_acme', 'proj_prod', NULL, 'card', 'Build Search Command Palette', '🔍', '[{"type":"paragraph","content":[{"type":"text","text":"Implement cmdk command palette with full-text search."}]}]', 1, 'a0', 0, 'usr_demo', ${now}, ${now}),
  ('np_card_2', 'ws_demo_acme', 'proj_prod', NULL, 'card', 'Verify D1 Invariants', '🛡️', '[{"type":"paragraph","content":[{"type":"text","text":"Ensure all 10 invariants hold under concurrent load."}]}]', 1, 'a0', 0, 'usr_bob', ${now}, ${now}),
  ('np_card_3', 'ws_demo_acme', 'proj_prod', NULL, 'card', 'Demo Reset Job (Every 2 Hours)', '⏱️', '[{"type":"paragraph","content":[{"type":"text","text":"Scheduled GitHub Action to wipe and re-seed demo data every 2 hours."}]}]', 1, 'a0', 0, 'usr_alice', ${now}, ${now});

INSERT INTO notepads_fts (notepad_id, project_id, title, body)
VALUES
  ('np_card_1', 'proj_prod', 'Build Search Command Palette', 'Implement cmdk command palette with full-text search.'),
  ('np_card_2', 'proj_prod', 'Verify D1 Invariants', 'Ensure all 10 invariants hold under concurrent load.'),
  ('np_card_3', 'proj_prod', 'Demo Reset Job (Every 2 Hours)', 'Scheduled GitHub Action to wipe and re-seed demo data every 2 hours.');

INSERT INTO cards (id, board_id, column_id, notepad_id, position, priority, due_date, created_at)
VALUES
  ('card_1', 'board_sprint', 'col_inprog', 'np_card_1', 'a0', 'high', ${now + 86400000}, ${now}),
  ('card_2', 'board_sprint', 'col_done', 'np_card_2', 'a0', 'medium', ${now - 86400000}, ${now}),
  ('card_3', 'board_sprint', 'col_todo', 'np_card_3', 'a1', 'high', ${now + 172800000}, ${now});

INSERT INTO card_assignees (card_id, user_id)
VALUES
  ('card_1', 'usr_demo'),
  ('card_2', 'usr_bob'),
  ('card_3', 'usr_alice');

INSERT INTO card_subtasks (id, card_id, title, completed, position, created_at)
VALUES
  ('sub_1', 'card_1', 'Keyboard shortcut listener (Cmd+K)', 1, 'a0', ${now}),
  ('sub_2', 'card_1', 'Query fuzzy matcher with highlighted tokens', 0, 'a1', ${now}),
  ('sub_3', 'card_3', 'Set up GitHub Actions cron schedule', 1, 'a0', ${now}),
  ('sub_4', 'card_3', 'Write idempotent reset & seed script', 1, 'a1', ${now});

INSERT INTO notepad_links (source_id, target_type, target_id)
VALUES
  ('np_card_1', 'notepad', 'np_arch'),
  ('np_card_3', 'notepad', 'np_welcome');
`;
}

async function main() {
  loadEnv();
  const isInteractive = Boolean(process.stdin.isTTY);
  const { target, isRemote, profile, expectedTarget, demoEmail, demoPassword, cleanR2 } = resolveDemoResetContext({
    args: process.argv.slice(2),
    env: process.env,
    isInteractive,
  });

  printTargetBanner('Demo Reset & Seed', target, { profile });

  if (isRemote && isInteractive) {
    const auth = assertDemoResetAllowed({
      profile,
      args: process.argv.slice(2),
      env: process.env,
      isInteractive,
    });
    if (auth.mode === 'interactive-demo') {
      const expectedPhrase = 'RESET-DEMO-BURROW';
      const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
      const answer = await rl.question(
        `Type "${expectedPhrase}" to confirm resetting and seeding remote demo (${profile.workerName} / ${profile.dbName}): `,
      );
      rl.close();
      if (answer.trim() !== expectedPhrase) {
        console.log('Reset cancelled.');
        process.exit(0);
      }
    }
  }

  let configArgs = [];
  if (isRemote) {
    if (expectedTarget) {
      step('Verifying exact Cloudflare account, D1 database, Worker, and R2 bucket for demo reset');
      const verified = verifyRemoteDemoResources({ expectedTarget });
      process.env.CLOUDFLARE_ACCOUNT_ID = verified.accountId;
      console.log(
        `  ✓ Verified demo target: account=${verified.accountId}, worker=${verified.workerName}, d1=${verified.databaseName} (${verified.databaseId}), r2=${verified.bucketName}`,
      );
      configArgs = getWranglerConfigArgs({
        d1IdOverride: verified.databaseId,
        required: true,
        purpose: 'remote demo reset',
        profile,
      });
    } else {
      configArgs = getWranglerConfigArgs({
        required: true,
        purpose: 'remote demo reset',
        profile,
      });
    }
  }

  // 1. Wipe existing state
  if (!isRemote) {
    if (target.kind === 'node') {
      assertResetDirectory(target.storagePath, root);
      step(`Resetting local SQLite database (${target.sqlitePath})`);
      try {
        for (const suffix of ['', '-wal', '-shm']) {
          fs.rmSync(`${target.sqlitePath}${suffix}`, { force: true });
        }
      } catch (err) {
        if (err.code === 'EBUSY') {
          const { default: Database } = await import('better-sqlite3');
          const sqlite = new Database(target.sqlitePath);
          try {
            sqlite.exec(cleanSql);
          } finally {
            sqlite.close();
          }
        } else {
          throw err;
        }
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
    step('Applying migrations');
    await migrateDatabase(target, { allowPreBaselineReset: true });
  } else {
    step(`Ensuring migrations are applied on Remote D1 (${profile.dbName})`);
    await migrateDatabase(target, {
      configArgs,
      databaseName: profile.dbName,
      allowPreBaselineReset: true,
    });

    inspectOrCleanRemoteR2References({
      configArgs,
      profile,
      cleanR2,
    });

    step(`Cleaning all records from Remote D1 (${profile.dbName})`);
    run(
      bin('wrangler'),
      [...configArgs, 'd1', 'execute', profile.dbName, '--remote', `--command=${cleanSql}`],
      { allowFail: false },
    );
  }

  // 2. Generate password hash
  step(`Hashing demo password for ${demoEmail}`);
  const passwordHash = await hashPassword(demoPassword);

  // 3. Write and execute demo seed SQL
  step('Seeding demo data (workspace, boards, cards, notepads)');
  const tempSeedFile = path.join(root, '.demo-seed-tmp.sql');
  try {
    fs.writeFileSync(tempSeedFile, buildDemoSeedSql(passwordHash, demoEmail), 'utf8');

    if (isRemote) {
      run(
        bin('wrangler'),
        [...configArgs, 'd1', 'execute', profile.dbName, '--remote', '--file', tempSeedFile],
        { allowFail: false },
      );
    } else {
      await executeDatabaseFile(target, tempSeedFile);
    }
  } finally {
    if (fs.existsSync(tempSeedFile)) fs.unlinkSync(tempSeedFile);
  }

  // 4. Verify invariants
  step('Verifying database invariants');
  const invariantFile = path.join(root, 'scripts', 'check-invariants.sql');
  const resultSets = await executeDatabaseFile(target, invariantFile, {
    readOnly: true,
    databaseName: profile?.dbName,
    configArgs: isRemote ? [...configArgs, '--remote'] : undefined,
  });
  const offenders = [];
  for (const rs of resultSets) {
    const rows = rs?.results ?? rs?.rows ?? [];
    for (const row of rows) {
      if (row && typeof row === 'object' && ('invariant' in row || 'subject' in row)) {
        offenders.push(row);
      }
    }
  }
  if (offenders.length > 0) {
    console.error(`❌ Invariant check FAILED: ${offenders.length} offending row(s)`);
    process.exit(1);
  }

  console.log('\n======================================================');
  console.log('✅ Demo reset & seed completed successfully!');
  console.log(`Demo Account:  ${demoEmail}`);
  console.log(`Demo Password: [configured]`);
  console.log('All 13 database invariants hold.');
  console.log('======================================================\n');
}

const isDirectExecution =
  Boolean(process.argv[1]) &&
  path.resolve(process.argv[1]).toLowerCase() === fileURLToPath(import.meta.url).toLowerCase();

if (isDirectExecution) {
  main().catch((err) => {
    console.error('❌ Demo reset aborted:', err instanceof Error ? err.message : err);
    process.exit(1);
  });
}

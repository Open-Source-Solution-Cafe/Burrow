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
  loadEnv,
  migrateDatabase,
  parseCliArgs,
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
  const profile = isRemote ? resolveRemoteProfile(baseCfg, { args, env }) : null;
  if (isRemote && profile) {
    assertDemoResetAllowed({ profile, args, env, isInteractive });
  }
  const demoEmail = validateDemoEmail(parsed.values['--email'] || env.DEMO_EMAIL || 'demo@osscafe.com');
  const demoPassword = parsed.values['--password'] || env.DEMO_PASSWORD || 'demopassword123';
  return {
    target,
    isRemote,
    profile,
    demoEmail,
    demoPassword,
    cleanR2: parsed.booleanFlags['--clean-r2'] === true,
  };
}

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
  const { target, isRemote, profile, demoEmail, demoPassword } = resolveDemoResetContext({
    args: process.argv.slice(2),
    env: process.env,
    isInteractive,
  });

  printTargetBanner('Demo Reset & Seed', target, { profile });

  if (isRemote && isInteractive && process.env.BURROW_DEMO_RESET_CONFIRM !== 'RESET-DEMO-BURROW') {
    const auth = assertDemoResetAllowed({
      profile,
      args: process.argv.slice(2),
      env: process.env,
      isInteractive,
    });
    if (auth.mode === 'staging-interactive' || auth.mode === 'interactive-demo') {
      const expectedPhrase = profile.isStaging ? 'RESET-STAGING' : 'RESET-DEMO-BURROW';
      const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
      const answer = await rl.question(
        `Type "${expectedPhrase}" to confirm resetting and seeding remote ${profile.envName}: `,
      );
      rl.close();
      if (answer.trim() !== expectedPhrase) {
        console.log('Reset cancelled.');
        process.exit(0);
      }
    }
  }

  const configArgs = isRemote
    ? getWranglerConfigArgs({ required: true, purpose: 'remote demo reset', profile })
    : [];

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

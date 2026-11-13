#!/usr/bin/env node
/**
 * Repeatable documentation screenshot capture script using Playwright Chromium.
 * Launches an isolated temporary Node SQLite server on port 4193, seeds rich
 * deterministic demo data, captures screenshots across desktop, mobile, and all
 * 3 themes, and removes all temporary database/runtime artifacts on exit.
 *
 * Usage:
 *   node scripts/capture-screenshots.mjs [--build]
 */
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';
import { hashPassword } from 'better-auth/crypto';
import { openSqliteDatabase } from '../src/server/sqlite.ts';
import { hasFlag, run } from './lib.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');
const outDir = path.join(root, 'docs', 'assets', 'screenshots');
const tmpDir = path.join(root, '.tmp-screenshots');
const PORT = 4193;
const BASE_URL = `http://127.0.0.1:${PORT}`;
const DEMO_EMAIL = 'alex@example.com';
const DEMO_PASSWORD = 'DemoPassword123!';

async function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForHealth(url, timeoutMs = 20000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await fetch(`${url}/api/health`);
      if (res.ok) return;
    } catch {
      // retry
    }
    await sleep(300);
  }
  throw new Error(`Timed out waiting for ${url}/api/health`);
}

function buildDeterministicSeedSql(passwordHash) {
  const now = Date.now();
  const day = 86_400_000;

  const archContent = JSON.stringify([
    {
      type: 'heading',
      props: { level: 2 },
      content: [{ type: 'text', text: 'Edge-First Architecture Overview' }],
    },
    {
      type: 'paragraph',
      content: [
        {
          type: 'text',
          text: 'Burrow separates pure domain services in src/core from platform adapters so the exact same workspace application runs on Cloudflare Workers + D1 + R2 or Node.js + Docker + PostgreSQL.',
        },
      ],
    },
    {
      type: 'bulletListItem',
      content: [
        { type: 'text', text: 'Cloudflare Workers + D1 SQLite + R2 object storage for zero-ops edge deployments' },
      ],
    },
    {
      type: 'bulletListItem',
      content: [
        { type: 'text', text: 'Full-text search powered by SQLite FTS5 or PostgreSQL generated tsvector indexes' },
      ],
    },
    {
      type: 'checkListItem',
      props: { checked: true },
      content: [{ type: 'text', text: 'Workspace-scoped authorization across all project APIs' }],
    },
    {
      type: 'checkListItem',
      props: { checked: false },
      content: [{ type: 'text', text: 'Publish v0.2 release documentation & screenshots' }],
    },
  ]).replace(/'/g, "''");

  const welcomeContent = JSON.stringify([
    {
      type: 'heading',
      props: { level: 2 },
      content: [{ type: 'text', text: 'Welcome to Burrow' }],
    },
    {
      type: 'paragraph',
      content: [
        {
          type: 'text',
          text: 'Organize specs, nested notepads, and Kanban project boards inside fast, self-hosted workspaces.',
        },
      ],
    },
  ]).replace(/'/g, "''");

  const childContent = JSON.stringify([
    {
      type: 'paragraph',
      content: [
        {
          type: 'text',
          text: 'D1 stores relational workspace entities alongside synchronized FTS5 search records while R2 holds uploaded media objects.',
        },
      ],
    },
  ]).replace(/'/g, "''");

  return `
    INSERT INTO user (id, name, email, emailVerified, createdAt, updatedAt) VALUES
      ('usr_alex', 'Alex Rivera', '${DEMO_EMAIL}', 1, ${now}, ${now}),
      ('usr_maya', 'Maya Lin', 'maya@example.com', 1, ${now}, ${now}),
      ('usr_sam', 'Sam Patel', 'sam@example.com', 1, ${now}, ${now});

    INSERT INTO account (id, accountId, providerId, userId, password, createdAt, updatedAt) VALUES
      ('acc_alex', 'usr_alex', 'credential', 'usr_alex', '${passwordHash}', ${now}, ${now});

    INSERT INTO workspaces (id, name, created_by, created_at) VALUES
      ('ws_demo_main', 'Burrow Studio', 'usr_alex', ${now});

    INSERT OR REPLACE INTO bootstrap_state (id, status, claim_email, user_id, workspace_id) VALUES
      (1, 'complete', '${DEMO_EMAIL}', 'usr_alex', 'ws_demo_main');

    INSERT INTO members (workspace_id, user_id, role, joined_at) VALUES
      ('ws_demo_main', 'usr_alex', 'owner', ${now}),
      ('ws_demo_main', 'usr_maya', 'editor', ${now}),
      ('ws_demo_main', 'usr_sam', 'editor', ${now});

    INSERT INTO projects (id, workspace_id, name, icon, color, position, created_at, updated_at) VALUES
      ('proj_platform', 'ws_demo_main', 'Platform Launch', '🚀', '#8b5cf6', 'a0', ${now}, ${now}),
      ('proj_design', 'ws_demo_main', 'Design System', '🎨', '#ec4899', 'a1', ${now}, ${now});

    INSERT INTO tags (id, project_id, name, color) VALUES
      ('tag_edge', 'proj_platform', 'edge', '#8b5cf6'),
      ('tag_ui', 'proj_platform', 'ui', '#3b82f6'),
      ('tag_security', 'proj_platform', 'security', '#10b981');

    INSERT INTO notepads (id, workspace_id, project_id, parent_id, kind, title, icon, content, version, position, is_favorite, created_by, created_at, updated_at) VALUES
      ('np_welcome', 'ws_demo_main', 'proj_platform', NULL, 'notepad', 'Welcome to Burrow', '👋', '${welcomeContent}', 1, 'a0', 1, 'usr_alex', ${now}, ${now}),
      ('np_arch', 'ws_demo_main', 'proj_platform', NULL, 'notepad', 'Engineering Architecture', '⚡', '${archContent}', 1, 'a1', 1, 'usr_alex', ${now}, ${now}),
      ('np_edge_d1', 'ws_demo_main', 'proj_platform', 'np_arch', 'notepad', 'Edge Storage & D1 Design', '🗄️', '${childContent}', 1, 'a0', 0, 'usr_maya', ${now}, ${now}),
      ('np_checklist', 'ws_demo_main', 'proj_platform', NULL, 'notepad', 'Release Checklist', '✅', '${welcomeContent}', 1, 'a2', 0, 'usr_sam', ${now}, ${now});

    INSERT INTO notepads_fts (notepad_id, project_id, title, body) VALUES
      ('np_welcome', 'proj_platform', 'Welcome to Burrow', 'Organize specs, nested notepads, and Kanban project boards inside fast self-hosted workspaces.'),
      ('np_arch', 'proj_platform', 'Engineering Architecture', 'Burrow separates pure domain services from platform adapters on Cloudflare Workers D1 R2 and Docker PostgreSQL.'),
      ('np_edge_d1', 'proj_platform', 'Edge Storage & D1 Design', 'D1 stores relational workspace entities and R2 holds uploaded media.'),
      ('np_checklist', 'proj_platform', 'Release Checklist', 'Pre-release verification checklist.');

    INSERT INTO notepad_tags (notepad_id, tag_id) VALUES
      ('np_arch', 'tag_edge'),
      ('np_edge_d1', 'tag_edge');

    INSERT INTO boards (id, workspace_id, project_id, name, icon, position, created_at, updated_at) VALUES
      ('board_release', 'ws_demo_main', 'proj_platform', 'Release Roadmap', '📋', 'a0', ${now}, ${now});

    INSERT INTO board_columns (id, board_id, name, position) VALUES
      ('col_todo', 'board_release', 'To do', 'a0'),
      ('col_inprog', 'board_release', 'In progress', 'a1'),
      ('col_done', 'board_release', 'Done', 'a2');

    INSERT INTO notepads (id, workspace_id, project_id, parent_id, kind, title, icon, content, version, position, is_favorite, created_by, created_at, updated_at) VALUES
      ('np_c1', 'ws_demo_main', 'proj_platform', NULL, 'card', 'Publish Cloudflare upgrade guide', '📘', '[]', 1, 'a0', 0, 'usr_alex', ${now}, ${now}),
      ('np_c2', 'ws_demo_main', 'proj_platform', NULL, 'card', 'Verify D1 Time Travel rollback', '⏱️', '[]', 1, 'a0', 0, 'usr_maya', ${now}, ${now}),
      ('np_c3', 'ws_demo_main', 'proj_platform', NULL, 'card', 'Ship Modern Dark default theme', '🎨', '[]', 1, 'a0', 0, 'usr_alex', ${now}, ${now}),
      ('np_c4', 'ws_demo_main', 'proj_platform', NULL, 'card', 'Add resizable navigation sidebar', '↔️', '[]', 1, 'a0', 0, 'usr_sam', ${now}, ${now}),
      ('np_c5', 'ws_demo_main', 'proj_platform', NULL, 'card', 'Run decoupling & license audits', '🛡️', '[]', 1, 'a0', 0, 'usr_maya', ${now}, ${now}),
      ('np_c6', 'ws_demo_main', 'proj_platform', NULL, 'card', 'Configure automated search indexing', '🔍', '[]', 1, 'a0', 0, 'usr_alex', ${now}, ${now});

    INSERT INTO notepads_fts (notepad_id, project_id, title, body) VALUES
      ('np_c1', 'proj_platform', 'Publish Cloudflare upgrade guide', 'Documentation and recovery runbook'),
      ('np_c2', 'proj_platform', 'Verify D1 Time Travel rollback', 'Bookmark before schema migration'),
      ('np_c3', 'proj_platform', 'Ship Modern Dark default theme', 'Sleek dark UI with theme toggle'),
      ('np_c4', 'proj_platform', 'Add resizable navigation sidebar', 'Drag-to-resize sidebar width'),
      ('np_c5', 'proj_platform', 'Run decoupling & license audits', 'Automated CI gate'),
      ('np_c6', 'proj_platform', 'Configure automated search indexing', 'FTS5 and PostgreSQL tsvector search');

    INSERT INTO cards (id, board_id, column_id, notepad_id, position, priority, due_date, created_at) VALUES
      ('card_1', 'board_release', 'col_todo', 'np_c1', 'a0', 'medium', ${now + 4 * day}, ${now}),
      ('card_2', 'board_release', 'col_todo', 'np_c2', 'a1', 'high', ${now + 2 * day}, ${now}),
      ('card_3', 'board_release', 'col_inprog', 'np_c3', 'a0', 'urgent', ${now + day}, ${now}),
      ('card_4', 'board_release', 'col_inprog', 'np_c4', 'a1', 'high', ${now + 3 * day}, ${now}),
      ('card_5', 'board_release', 'col_done', 'np_c5', 'a0', 'medium', ${now - day}, ${now}),
      ('card_6', 'board_release', 'col_done', 'np_c6', 'a1', 'low', ${now - 2 * day}, ${now});

    INSERT INTO card_assignees (card_id, user_id) VALUES
      ('card_1', 'usr_alex'),
      ('card_2', 'usr_maya'),
      ('card_3', 'usr_alex'),
      ('card_4', 'usr_sam'),
      ('card_5', 'usr_maya'),
      ('card_6', 'usr_alex');

    INSERT INTO card_subtasks (id, card_id, title, completed, position, created_at) VALUES
      ('sub_1', 'card_3', 'Set Modern Dark as default theme', 1, 'a0', ${now}),
      ('sub_2', 'card_3', 'Support Basalt Dark and Basalt Light', 1, 'a1', ${now}),
      ('sub_3', 'card_4', 'Persist custom width in localStorage', 1, 'a0', ${now}),
      ('sub_4', 'card_4', 'Verify mobile drawer layout', 0, 'a1', ${now});

    INSERT INTO notepad_tags (notepad_id, tag_id) VALUES
      ('np_c1', 'tag_edge'),
      ('np_c2', 'tag_security'),
      ('np_c3', 'tag_ui'),
      ('np_c4', 'tag_ui'),
      ('np_c5', 'tag_security'),
      ('np_c6', 'tag_edge');
  `;
}

async function main() {
  const needsBuild =
    hasFlag('--build') ||
    !fs.existsSync(path.join(root, 'dist', 'web', 'index.html')) ||
    !fs.existsSync(path.join(root, 'dist', 'server.mjs'));

  if (needsBuild) {
    console.log('==> Building web bundle & Node server for screenshot capture...');
    run('pnpm', ['run', 'build']);
  }

  fs.rmSync(tmpDir, { recursive: true, force: true });
  fs.mkdirSync(path.join(tmpDir, 'uploads'), { recursive: true });
  fs.mkdirSync(outDir, { recursive: true });

  const sqlitePath = path.join(tmpDir, 'burrow-screenshots.db');
  const uploadsPath = path.join(tmpDir, 'uploads');

  console.log('==> Initializing deterministic screenshot database...');
  const passwordHash = await hashPassword(DEMO_PASSWORD);
  const sqlite = openSqliteDatabase(sqlitePath, path.join(root, 'migrations'));
  sqlite.exec(buildDeterministicSeedSql(passwordHash));
  sqlite.close();

  console.log(`==> Starting temporary Burrow server on ${BASE_URL}...`);
  const serverProc = spawn(process.execPath, [path.join(root, 'dist', 'server.mjs')], {
    cwd: root,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      ...process.env,
      NODE_ENV: 'development',
      PORT: String(PORT),
      SQLITE_PATH: sqlitePath,
      LOCAL_STORAGE_PATH: uploadsPath,
      DATABASE_URL: '',
      BETTER_AUTH_SECRET: 'screenshot-ephemeral-secret-32-bytes-minimum!!',
      BETTER_AUTH_URL: BASE_URL,
      BOOTSTRAP_TOKEN: 'screenshot-ephemeral-bootstrap-token',
    },
  });
  serverProc.stdout.on('data', (chunk) => process.stdout.write(`[server] ${chunk}`));
  serverProc.stderr.on('data', (chunk) => process.stderr.write(`[server:err] ${chunk}`));

  const killServer = () => {
    try {
      if (process.platform === 'win32') {
        spawnSync('taskkill', ['/pid', String(serverProc.pid), '/T', '/F'], { stdio: 'ignore' });
      } else {
        serverProc.kill('SIGTERM');
      }
    } catch {
      // ignore
    }
  };

  try {
    await waitForHealth(BASE_URL);
    const browser = await chromium.launch({ headless: true });

    try {
      const context = await browser.newContext({
        viewport: { width: 1440, height: 900 },
        deviceScaleFactor: 1,
      });
      const page = await context.newPage();

      // Log in via API directly inside browser context so session cookies are set cleanly
      const signInRes = await page.request.post(`${BASE_URL}/api/auth/sign-in/email`, {
        data: { email: DEMO_EMAIL, password: DEMO_PASSWORD },
      });
      if (!signInRes.ok()) {
        throw new Error(`Sign-in failed: ${signInRes.status()} ${await signInRes.text()}`);
      }

      const capture = async (urlPath, filename, { theme = 'modern', afterNav } = {}) => {
        await page.goto(`${BASE_URL}${urlPath}`);
        await page.evaluate((t) => {
          localStorage.setItem('burrow-theme', t);
          document.documentElement.setAttribute('data-theme', t);
          if (t === 'light') {
            document.documentElement.classList.remove('dark');
            document.documentElement.style.colorScheme = 'light';
          } else {
            document.documentElement.classList.add('dark');
            document.documentElement.style.colorScheme = 'dark';
          }
          window.dispatchEvent(new CustomEvent('burrow:theme-change', { detail: t }));
        }, theme);
        await page.reload();
        await page.waitForLoadState('networkidle');
        if (afterNav) await afterNav(page);
        await page.waitForTimeout(450);
        const dest = path.join(outDir, filename);
        await page.screenshot({ path: dest, type: 'png' });
        const sizeKb = (fs.statSync(dest).size / 1024).toFixed(1);
        console.log(`  ✓ Captured ${filename} (${sizeKb} KB)`);
      };

      const projectBase = '/w/ws_demo_main/p/proj_platform';

      await capture(projectBase, 'dashboard-modern.png', { theme: 'modern' });
      await capture(`${projectBase}/boards/board_release`, 'kanban-board.png', { theme: 'modern' });
      await capture(`${projectBase}/notepads/np_arch`, 'editor-nested.png', {
        theme: 'modern',
        afterNav: async (p) => {
          // Wait for BlockNote editor paragraph/heading to render
          await p.locator('text=Edge-First Architecture Overview').first().waitFor({ timeout: 8000 });
          // Expand nested notepad tree item if collapsed so child page is visible in sidebar
          const sidebarLink = p.locator('a', { hasText: 'Engineering Architecture' }).first();
          const row = sidebarLink.locator('..');
          const expandBtn = row.locator('button').first();
          if ((await expandBtn.count()) > 0 && (await p.locator('a', { hasText: 'Edge Storage & D1 Design' }).count()) === 0) {
            await expandBtn.click().catch(() => {});
          }
        },
      });
      await capture(`${projectBase}/boards/board_release`, 'theme-basalt-dark.png', {
        theme: 'basalt',
      });
      await capture(`${projectBase}/boards/board_release`, 'theme-basalt-light.png', {
        theme: 'light',
      });

      // Mobile responsive viewport
      await page.setViewportSize({ width: 390, height: 844 });
      await capture(`${projectBase}/boards/board_release`, 'mobile-layout.png', {
        theme: 'modern',
      });

      await context.close();
    } finally {
      await browser.close();
    }
  } finally {
    killServer();
    await sleep(500);
    fs.rmSync(tmpDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  }

  console.log(`\nAll screenshots saved to ${path.relative(root, outDir)}`);
}

main().catch((err) => {
  console.error('\n❌ Screenshot capture failed:', err);
  process.exit(1);
});

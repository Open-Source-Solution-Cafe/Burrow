import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { Hono } from 'hono';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { BurrowServerPlugin } from '@burrow/sdk';
import {
  PluginEventBus,
  assertPluginSqlAllowed,
  createCoreApp,
  createPluginDb,
  runPluginMigrations,
  splitPluginSqlStatements,
} from '../../src/core';
import { SelfHostedPolicy } from '../../src/core/policy';

const tmpDirs: string[] = [];

function createTempSqlite(): Database.Database {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'burrow-audit-test-'));
  tmpDirs.push(dir);
  return new Database(path.join(dir, 'audit.sqlite'));
}

afterEach(() => {
  for (const dir of tmpDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe('Audit Adversarial Probes: Plugin Isolation, SQL Guard, and Dialect Gaps', () => {
  it('SQL guard bypass #1: double-quoted identifier containing apostrophe desyncs stripCommentsAndStrings and wipes core table', async () => {
    const sqlite = createTempSqlite();
    try {
      sqlite.exec(`
        CREATE TABLE workspaces (id TEXT PRIMARY KEY, name TEXT NOT NULL);
        INSERT INTO workspaces (id, name) VALUES ('ws_victim', 'Victim Workspace');
      `);
      const db = createPluginDb(sqlite, 'evil');

      // Vulnerability: stripCommentsAndStrings does not track double-quoted identifiers,
      // so the apostrophe inside "a'b" opens a single-quote state and hides DELETE FROM workspaces.
      await db.execute(
        `WITH cte AS (SELECT 1 AS "a'b") DELETE FROM workspaces WHERE 'x' = 'x'`,
      );

      const remaining = sqlite.prepare('SELECT id FROM workspaces').all();
      expect(remaining).toEqual([]);
    } finally {
      sqlite.close();
    }
  });

  it('SQL guard bypass #2: Postgres dollar-quoting, SELECT INTO, and WITH MERGE bypass assertPluginSqlAllowed', () => {
    // Vulnerability: dollar-quoted strings ($$...$$) are not parsed by stripCommentsAndStrings or splitPluginSqlStatements.
    expect(() =>
      assertPluginSqlAllowed('evil', `WITH cte AS (SELECT $$a'b$$) DELETE FROM workspaces WHERE '1' = '1'`),
    ).not.toThrow();

    // splitPluginSqlStatements splits on ';' inside Postgres $$...$$ blocks (3 fragments instead of 1).
    expect(splitPluginSqlStatements('SELECT $$; DELETE FROM workspaces; $$')).toHaveLength(3);

    // Postgres SELECT ... INTO creates an unprefixed table while matching ^SELECT\b.
    expect(() =>
      assertPluginSqlAllowed('evil', 'SELECT * INTO evil_unprefixed FROM workspaces'),
    ).not.toThrow();

    // Postgres WITH ... MERGE INTO passes because statement begins with WITH and MERGE is not in dmlPatterns.
    expect(() =>
      assertPluginSqlAllowed(
        'evil',
        'WITH src AS (SELECT 1 AS id) MERGE INTO workspaces t USING src s ON t.id = s.id WHEN MATCHED THEN DELETE',
      ),
    ).not.toThrow();
  });

  it('Isolation gap #1: PluginDb allows SELECT across core secrets (_worker_runtime_config), other plugins, and all workspaces', async () => {
    const sqlite = createTempSqlite();
    try {
      sqlite.exec(`
        CREATE TABLE _worker_runtime_config (key TEXT PRIMARY KEY, value TEXT NOT NULL);
        INSERT INTO _worker_runtime_config (key, value) VALUES ('better_auth_secret', 'super-secret-signing-key');
        CREATE TABLE workspaces (id TEXT PRIMARY KEY, name TEXT NOT NULL);
        INSERT INTO workspaces (id, name) VALUES ('ws_a', 'Workspace A'), ('ws_b', 'Workspace B');
        CREATE TABLE plugin_other_tokens (id TEXT PRIMARY KEY, token TEXT NOT NULL);
        INSERT INTO plugin_other_tokens (id, token) VALUES ('t1', 'other-plugin-secret');
      `);

      const db = createPluginDb(sqlite, 'reader');
      const secretRows = await db.query<{ value: string }>(
        "SELECT value FROM _worker_runtime_config WHERE key = 'better_auth_secret'",
      );
      const otherPluginRows = await db.query<{ token: string }>(
        'SELECT token FROM plugin_other_tokens',
      );
      const allWorkspaces = await db.query<{ id: string }>('SELECT id FROM workspaces');

      expect(secretRows).toEqual([{ value: 'super-secret-signing-key' }]);
      expect(otherPluginRows).toEqual([{ token: 'other-plugin-secret' }]);
      expect(allWorkspaces).toEqual([{ id: 'ws_a' }, { id: 'ws_b' }]);
    } finally {
      sqlite.close();
    }
  });

  it('Isolation gap #2: Plugin with permissions: [] still receives raw ctx.env secrets and ctx.infra DB access', () => {
    const sqlite = createTempSqlite();
    try {
      sqlite.exec("CREATE TABLE workspaces (id TEXT PRIMARY KEY); INSERT INTO workspaces VALUES ('ws_1');");
      let leakedSecret: unknown;
      let bypassedRowCount = 0;

      const zeroPermPlugin: BurrowServerPlugin = {
        manifest: {
          id: 'zero-perm',
          version: '0.1.0',
          sdkVersion: '^0.4.0',
          permissions: [],
        },
        setup(ctx) {
          leakedSecret = ctx.env.BETTER_AUTH_SECRET;
          const rawDb = (ctx.infra as { db?: Database.Database }).db;
          if (rawDb) {
            rawDb.exec("DELETE FROM workspaces WHERE id = 'ws_1'");
            bypassedRowCount = rawDb.prepare('SELECT COUNT(*) AS c FROM workspaces').get()
              ? (rawDb.prepare('SELECT COUNT(*) AS c FROM workspaces').get() as { c: number }).c
              : -1;
          }
        },
      };

      createCoreApp(
        {
          repositories: {
            workspaces: { listByUser: vi.fn().mockResolvedValue([]), count: vi.fn().mockResolvedValue(0) } as any,
            members: { findByUserId: vi.fn().mockResolvedValue(null) } as any,
            projects: {} as any,
            notepads: {} as any,
            projectFiles: {} as any,
            boards: {} as any,
            cards: {} as any,
            tags: {} as any,
            notifications: {} as any,
            invites: {} as any,
          },
          storage: {} as any,
          search: {} as any,
          locks: {} as any,
          auth: {
            getSession: vi.fn().mockResolvedValue(null),
            handler: vi.fn().mockResolvedValue(new Response('ok')),
          },
          email: { provider: 'console', send: vi.fn() },
          bootstrapToken: '',
          env: { BETTER_AUTH_SECRET: 'leaked-master-secret-32-bytes!!!!' },
          db: sqlite,
        },
        { policy: new SelfHostedPolicy(), plugins: [zeroPermPlugin], rawDb: sqlite },
      );

      expect(leakedSecret).toBe('leaked-master-secret-32-bytes!!!!');
      expect(bypassedRowCount).toBe(0);
    } finally {
      sqlite.close();
    }
  });

  it('Route & safety gap: plugin can mount unauthenticated routes on arbitrary mountPath and omit workspace middleware', async () => {
    const sqlite = createTempSqlite();
    try {
      const customRoutePlugin: BurrowServerPlugin = {
        manifest: {
          id: 'arbitrary-mount',
          version: '0.1.0',
          sdkVersion: '^0.4.0',
          permissions: ['routes:api'],
        },
        setup(ctx) {
          const router = new Hono();
          // Intentionally omits requireIdentity / requireWorkspace
          router.get('/open', (c) => c.json({ unauthenticated: true }));
          ctx.route(router, { mountPath: '/api/arbitrary-root' });
        },
      };

      const app = createCoreApp(
        {
          repositories: {
            workspaces: { listByUser: vi.fn().mockResolvedValue([]), count: vi.fn().mockResolvedValue(0) } as any,
            members: { findByUserId: vi.fn().mockResolvedValue(null) } as any,
            projects: {} as any,
            notepads: {} as any,
            projectFiles: {} as any,
            boards: {} as any,
            cards: {} as any,
            tags: {} as any,
            notifications: {} as any,
            invites: {} as any,
          },
          storage: {} as any,
          search: {} as any,
          locks: {} as any,
          auth: {
            getSession: vi.fn().mockResolvedValue(null),
            handler: vi.fn().mockResolvedValue(new Response('ok')),
          },
          email: { provider: 'console', send: vi.fn() },
          bootstrapToken: '',
          env: {},
        },
        { policy: new SelfHostedPolicy(), plugins: [customRoutePlugin], rawDb: sqlite },
      );

      const res = await app.request('http://localhost/api/arbitrary-root/open');
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ unauthenticated: true });
    } finally {
      sqlite.close();
    }
  });

  it('Error & Postgres dialect gap: before* crash aborts operation, after* blocks without waitUntil, and Postgres client silently skips plugin migrations', async () => {
    const bus = new PluginEventBus();
    bus.onBefore('task.created', () => {
      throw new TypeError('unexpected bug in plugin guard');
    });

    await expect(
      bus.emitBefore('task.created', {
        workspaceId: 'w1',
        projectId: 'p1',
        boardId: 'b1',
        columnId: 'c1',
        cardId: 'card1',
        notepadId: 'np1',
        title: 'Test',
        actorId: 'u1',
      }),
    ).rejects.toThrow(TypeError);

    let afterFinished = false;
    bus.on('notepad.saved', async () => {
      await new Promise((resolve) => setTimeout(resolve, 25));
      afterFinished = true;
    });
    // Without ExecutionContext.waitUntil (e.g., Node/Postgres server), emitAfter blocks inline.
    await bus.emitAfter('notepad.saved', {
      workspaceId: 'w1',
      projectId: 'p1',
      notepadId: 'np1',
      version: 2,
      actorId: 'u1',
      content: '[]',
    });
    expect(afterFinished).toBe(true);

    // Postgres-like tagged template client (no .prepare()) causes runPluginMigrations to silently return []
    const fakePostgresClient = Object.assign(async () => [], {
      unsafe: async () => [],
      begin: async () => {},
    });
    const pluginWithMigration: BurrowServerPlugin = {
      manifest: {
        id: 'pg-check',
        version: '0.1.0',
        sdkVersion: '^0.4.0',
        permissions: ['db:own'],
      },
      migrations: [
        {
          name: '0001_init.sql',
          sql: 'CREATE TABLE IF NOT EXISTS plugin_pg_check_items (id TEXT PRIMARY KEY);',
        },
      ],
      setup() {},
    };

    await expect(runPluginMigrations(fakePostgresClient, [pluginWithMigration])).resolves.toEqual([]);
    const pgPluginDb = createPluginDb(fakePostgresClient, 'pg-check');
    await expect(pgPluginDb.query('SELECT 1')).rejects.toThrow('database binding is not available');
  });
});

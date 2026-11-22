import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { Hono } from 'hono';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { BurrowServerPlugin } from '@burrow/sdk';
import {
  PluginEventBus,
  PluginManifestError,
  PluginSqlAccessError,
  createCoreApp,
  createPluginDb,
  httpError,
  runPluginMigrations,
  runWithEventExecutionContext,
  validatePluginManifest,
} from '../../src/core';
import { SelfHostedPolicy } from '../../src/core/policy';
import { helloPlugin } from '../../packages/plugins/hello/src/index';

const tmpDirs: string[] = [];
function tempSqlite() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'burrow-plugins-test-'));
  tmpDirs.push(dir);
  return new Database(path.join(dir, 'test.sqlite'));
}

afterEach(() => {
  for (const dir of tmpDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe('Plugin Manifest Validation', () => {
  it('accepts valid manifests with compatible SDK SemVer ranges', () => {
    expect(() =>
      validatePluginManifest({
        id: 'hello-world',
        version: '1.2.3',
        sdkVersion: '^0.4.0',
        permissions: ['db:own', 'routes:api', 'events:read'],
      }),
    ).not.toThrow();
  });

  it('rejects invalid plugin ids, non-semver versions, incompatible sdk ranges, and unknown permissions', () => {
    expect(() =>
      validatePluginManifest({
        id: 'Bad_Plugin!',
        version: '1.0.0',
        sdkVersion: '^0.4.0',
        permissions: [],
      }),
    ).toThrow(PluginManifestError);

    expect(() =>
      validatePluginManifest({
        id: 'good-id',
        version: 'not-semver',
        sdkVersion: '^0.4.0',
        permissions: [],
      }),
    ).toThrow(PluginManifestError);

    expect(() =>
      validatePluginManifest(
        {
          id: 'future-plugin',
          version: '1.0.0',
          sdkVersion: '^2.0.0',
          permissions: [],
        },
        '0.4.0',
      ),
    ).toThrow(PluginManifestError);

    expect(() =>
      validatePluginManifest({
        id: 'bad-perm',
        version: '1.0.0',
        sdkVersion: '^0.4.0',
        permissions: ['root:all' as any],
      }),
    ).toThrow(PluginManifestError);
  });
});

describe('PluginDb Table Prefix Guard', () => {
  it('allows DDL/DML on plugin_<id>_* tables with FKs to core tables and rejects core/cross-plugin writes', async () => {
    const sqlite = tempSqlite();
    try {
      sqlite.exec("CREATE TABLE workspaces (id TEXT PRIMARY KEY); INSERT INTO workspaces VALUES ('ws_1');");
      sqlite.exec('CREATE TABLE cards (id TEXT PRIMARY KEY);');
      const db = createPluginDb(sqlite, 'my-plugin');
      expect(db.prefix).toBe('plugin_my_plugin_');

      await db.execute(
        'CREATE TABLE IF NOT EXISTS plugin_my_plugin_items (id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE)',
      );
      await db.execute(
        'INSERT INTO plugin_my_plugin_items (id, workspace_id) VALUES (?, ?) ON CONFLICT(id) DO UPDATE SET workspace_id = excluded.workspace_id',
        ['i_1', 'ws_1'],
      );
      const rows = await db.query<{ id: string }>('SELECT id FROM plugin_my_plugin_items');
      expect(rows).toEqual([{ id: 'i_1' }]);

      // Rejects direct core table mutations and cross-plugin table writes
      await expect(
        db.execute('INSERT INTO workspaces (id) VALUES (?)', ['ws_2']),
      ).rejects.toThrow(PluginSqlAccessError);
      await expect(
        db.execute('UPDATE cards SET id = ? WHERE id = ?', ['a', 'b']),
      ).rejects.toThrow(PluginSqlAccessError);
      await expect(
        db.execute('DELETE FROM workspaces WHERE id = ?', ['ws_1']),
      ).rejects.toThrow(PluginSqlAccessError);
      await expect(db.execute('DROP TABLE workspaces')).rejects.toThrow(PluginSqlAccessError);
      await expect(db.execute('ALTER TABLE workspaces ADD COLUMN extra TEXT')).rejects.toThrow(
        PluginSqlAccessError,
      );
      await expect(
        db.execute('CREATE TRIGGER trg_bad AFTER DELETE ON workspaces BEGIN SELECT 1; END'),
      ).rejects.toThrow(PluginSqlAccessError);
      await expect(db.execute('PRAGMA foreign_keys = OFF')).rejects.toThrow(PluginSqlAccessError);
      await expect(
        db.execute('WITH c AS (SELECT 1) DELETE FROM workspaces'),
      ).rejects.toThrow(PluginSqlAccessError);
      await expect(
        db.execute('INSERT INTO plugin_other_items (id) VALUES (?)', ['x']),
      ).rejects.toThrow(PluginSqlAccessError);
    } finally {
      sqlite.close();
    }
  });
});

describe('Plugin Migrations Idempotency', () => {
  it('runs plugin migrations once in plugin_migrations ledger and rolls back on failure', async () => {
    const sqlite = tempSqlite();
    try {
      const firstRun = await runPluginMigrations(sqlite, [helloPlugin]);
      expect(firstRun).toEqual(['hello:0001_init.sql']);

      const secondRun = await runPluginMigrations(sqlite, [helloPlugin]);
      expect(secondRun).toEqual([]);

      const ledger = sqlite
        .prepare('SELECT plugin_id, name FROM plugin_migrations')
        .all() as Array<{ plugin_id: string; name: string }>;
      expect(ledger).toEqual([{ plugin_id: 'hello', name: '0001_init.sql' }]);

      const badPlugin: BurrowServerPlugin = {
        manifest: {
          id: 'broken',
          version: '0.1.0',
          sdkVersion: '^0.4.0',
          permissions: ['db:own'],
        },
        migrations: [
          {
            name: '0001_bad.sql',
            sql: 'CREATE TABLE plugin_broken_ok (id TEXT PRIMARY KEY); INSERT INTO nonexistent_table VALUES (1);',
          },
        ],
        setup() {},
      };
      await expect(runPluginMigrations(sqlite, [badPlugin])).rejects.toThrow();
      expect(
        sqlite.prepare("SELECT name FROM sqlite_master WHERE name = 'plugin_broken_ok'").get(),
      ).toBeUndefined();
    } finally {
      sqlite.close();
    }
  });
});

describe('PluginEventBus Ordering & waitUntil', () => {
  it('runs before* synchronously to abort and dispatches after* via waitUntil', async () => {
    const bus = new PluginEventBus();
    const trace: string[] = [];

    bus.onBefore('task.created', async (payload) => {
      trace.push(`before:${payload.title}`);
      if (payload.title === 'BLOCK') {
        throw httpError(402, 'limit_reached', 'Blocked by plugin guard');
      }
    });
    bus.on('task.created', async (payload) => {
      trace.push(`after:${payload.title}`);
    });

    await expect(
      bus.emitBefore('task.created', {
        workspaceId: 'w1',
        projectId: 'p1',
        boardId: 'b1',
        columnId: 'c1',
        cardId: 'card1',
        notepadId: 'np1',
        title: 'BLOCK',
        actorId: 'u1',
      }),
    ).rejects.toMatchObject({ status: 402, code: 'limit_reached' });

    const bgTasks: Promise<unknown>[] = [];
    await runWithEventExecutionContext(
      { waitUntil: (p) => bgTasks.push(p) },
      async () => {
        await bus.emitBefore('task.created', {
          workspaceId: 'w1',
          projectId: 'p1',
          boardId: 'b1',
          columnId: 'c1',
          cardId: 'card2',
          notepadId: 'np2',
          title: 'OK',
          actorId: 'u1',
        });
        await bus.emitAfter('task.created', {
          workspaceId: 'w1',
          projectId: 'p1',
          boardId: 'b1',
          columnId: 'c1',
          cardId: 'card2',
          notepadId: 'np2',
          title: 'OK',
          actorId: 'u1',
        });
      },
    );

    expect(bgTasks.length).toBe(1);
    await Promise.all(bgTasks);
    expect(trace).toEqual(['before:BLOCK', 'before:OK', 'after:OK']);
  });
});

describe('AuthProvider.getPublicConfig & Route Mounting', () => {
  it('merges AuthProvider.getPublicConfig() into /api/auth/config and mounts plugin routes', async () => {
    const sqlite = tempSqlite();
    try {
      await runPluginMigrations(sqlite, [helloPlugin]);
      const customAuthPlugin: BurrowServerPlugin = {
        manifest: {
          id: 'sso-mock',
          version: '0.1.0',
          sdkVersion: '^0.4.0',
          permissions: ['auth:override', 'routes:api'],
        },
        setup(ctx) {
          ctx.setAdapters({
            auth: {
              getSession: vi.fn().mockImplementation(async (headers: Headers) =>
                headers.get('cookie') ? { userId: 'u1', email: 'a@b.com' } : null,
              ),
              handler: vi.fn().mockResolvedValue(new Response('ok')),
              getPublicConfig: () => ({
                signupMode: 'open',
                emailPasswordEnabled: false,
                oauthProviders: [
                  {
                    id: 'corp-oidc',
                    name: 'Corporate SSO',
                    kind: 'oidc',
                    authUrl: '/api/plugins/sso-mock/authorize',
                  },
                ],
              }),
            },
          });
          const r = new Hono();
          r.get('/authorize', (c) => c.json({ redirect: 'https://idp.example.com/auth' }));
          ctx.route(r);
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
        { policy: new SelfHostedPolicy(), plugins: [helloPlugin, customAuthPlugin], rawDb: sqlite },
      );

      const authRes = await app.request('http://localhost/api/auth/config');
      expect(authRes.status).toBe(200);
      expect(await authRes.json()).toMatchObject({
        signupMode: 'open',
        emailPasswordEnabled: false,
        oauthProviders: [
          {
            id: 'corp-oidc',
            name: 'Corporate SSO',
            kind: 'oidc',
            authUrl: '/api/plugins/sso-mock/authorize',
          },
        ],
      });

      const pingRes = await app.request('http://localhost/api/plugins/hello/ping');
      expect(pingRes.status).toBe(200);
      expect(await pingRes.json()).toEqual({ ok: true, plugin: 'hello', prefix: 'plugin_hello_' });

      const unauthLogsRes = await app.request(
        'http://localhost/api/plugins/hello/workspaces/ws_1/logs',
      );
      expect(unauthLogsRes.status).toBe(401);
    } finally {
      sqlite.close();
    }
  });
});

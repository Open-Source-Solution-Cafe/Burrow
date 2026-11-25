import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { Hono } from 'hono';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import type { BurrowServerPlugin } from '@burrow/sdk';
import { createCoreApp } from '../../src/core/app';
import { LocalStorageAdapter } from '../../src/core/adapters/storage/local';
import { SelfHostedPolicy } from '../../src/core/policy';
import { collectSecretValues, createPluginLogger } from '../../src/core/plugins/logger';
import { PluginRuntimeRegistry } from '../../src/core/plugins/runtime-state';

const tmpDirs: string[] = [];

function tempSqlite() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'burrow-redteam-ctx-'));
  tmpDirs.push(dir);
  return { dir, sqlite: new Database(path.join(dir, 'test.sqlite')) };
}

afterEach(() => {
  for (const dir of tmpDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function makeBaseInfra(
  dir: string,
  overrides: Partial<{
    users: Record<string, { userId: string; email: string }>;
    memberships: Record<string, Array<{ id: string; name: string; role: 'owner' | 'editor' | 'viewer'; createdAt: number }>>;
    instanceOwners: Set<string>;
    env: Record<string, unknown>;
  }> = {},
) {
  const users = overrides.users ?? {
    'tok-owner': { userId: 'u_owner', email: 'owner@test.local' },
    'tok-viewer': { userId: 'u_viewer', email: 'viewer@test.local' },
    'tok-ws2-owner': { userId: 'u_ws2_owner', email: 'ws2@test.local' },
    'tok-outsider': { userId: 'u_outsider', email: 'outsider@test.local' },
  };
  const memberships = overrides.memberships ?? {
    u_owner: [{ id: 'ws1', name: 'Workspace 1', role: 'owner', createdAt: 1 }],
    u_viewer: [{ id: 'ws1', name: 'Workspace 1', role: 'viewer', createdAt: 1 }],
    u_ws2_owner: [{ id: 'ws2', name: 'Workspace 2', role: 'owner', createdAt: 2 }],
    u_outsider: [],
  };
  const instanceOwners = overrides.instanceOwners ?? new Set(['u_owner']);

  return {
    repositories: {
      workspaces: {
        listByUser: vi.fn().mockImplementation(async (uid: string) => memberships[uid] ?? []),
        count: vi.fn().mockResolvedValue(2),
        isInstanceOwner: vi.fn().mockImplementation(async (uid: string) => instanceOwners.has(uid)),
        findById: vi.fn().mockImplementation(async (wid: string) =>
          wid === 'ws1' ? { id: 'ws1', name: 'Workspace 1', createdAt: 1 } : null,
        ),
      } as any,
      members: {
        findByUserId: vi.fn().mockImplementation(async (wid: string, uid: string) => {
          const list = memberships[uid] ?? [];
          const found = list.find((w) => w.id === wid);
          return found ? { workspaceId: wid, userId: uid, role: found.role, joinedAt: 1 } : null;
        }),
      } as any,
      projects: {
        findByIdAndWorkspace: vi.fn().mockResolvedValue(null),
      } as any,
      notepads: {} as any,
      projectFiles: {} as any,
      boards: {} as any,
      cards: {} as any,
      tags: {} as any,
      notifications: {} as any,
      invites: {} as any,
    },
    storage: new LocalStorageAdapter(path.join(dir, 'uploads')),
    search: {} as any,
    locks: {} as any,
    auth: {
      getSession: vi.fn().mockImplementation(async (headers: Headers) => {
        const cookie = headers.get('cookie') ?? '';
        const token = cookie.replace(/^session=/, '').trim();
        return users[token] ?? null;
      }),
      handler: vi.fn().mockResolvedValue(new Response('ok')),
    },
    email: { provider: 'console', send: vi.fn() } as any,
    bootstrapToken: '',
    env: overrides.env ?? {
      BETTER_AUTH_SECRET: 'super-secret-better-auth-key-32bytes!',
      RESEND_API_KEY: 're_secret_test_key_12345',
    },
  };
}

describe('Category 3, 4, 7, 13 — Context, Routes, Authz, CSRF & Admin Surface', () => {
  describe('Confirmed Vulnerabilities (secure assertions expected to fail)', () => {
    it('does not leak Hono Worker c.env secrets or raw DB bindings to external plugin route handlers', async () => {
      const { dir, sqlite } = tempSqlite();
      try {
        let capturedEnvKeys: string[] = [];
        let capturedAuthSecret: unknown;

        const hostilePlugin: BurrowServerPlugin = {
          manifest: {
            id: 'env-sniffer',
            version: '0.1.0',
            sdkVersion: '^0.4.0',
            permissions: ['routes:public'],
          },
          setup(ctx) {
            ctx.defineRoute({
              method: 'GET',
              path: '/probe',
              public: true,
              schemas: {},
              handler(c: any) {
                capturedEnvKeys = Object.keys(c.env ?? {});
                capturedAuthSecret = c.env?.BETTER_AUTH_SECRET;
                return c.json({ ok: true });
              },
            });
          },
        };

        const infra = makeBaseInfra(dir);
        const app = createCoreApp(infra as any, {
          policy: new SelfHostedPolicy(),
          plugins: [hostilePlugin],
          rawDb: sqlite,
        });

        // Simulate Cloudflare Worker / Hono fetch passing host env bindings to app.fetch(req, env)
        const workerBindings = {
          BETTER_AUTH_SECRET: 'worker-prod-auth-secret-should-be-hidden!',
          BOOTSTRAP_TOKEN: 'worker-bootstrap-secret-token',
          DB: { prepare: () => {} },
        };
        const res = await app.fetch(
          new Request('http://localhost/api/plugins/env-sniffer/probe'),
          workerBindings as any,
        );
        expect(res.status).toBe(200);
        expect(capturedAuthSecret).toBeUndefined();
        expect(capturedEnvKeys).not.toContain('DB');
        expect(capturedEnvKeys).not.toContain('BETTER_AUTH_SECRET');
      } finally {
        sqlite.close();
      }
    });

    it('prevents plugins from mutating ctx.manifest after registration to spoof the admin consent screen', async () => {
      const { dir, sqlite } = tempSqlite();
      try {
        const lyingPlugin: BurrowServerPlugin = {
          manifest: {
            id: 'consent-liar',
            version: '0.1.0',
            sdkVersion: '^0.4.0',
            permissions: ['db:own', 'routes:public', 'auth:override'],
            network: ['evil.example.com'],
            coreTables: ['invites'],
            configKeys: ['PLUGIN_API_KEY'],
          },
          setup(ctx) {
            // Mutate manifest in-place after loadServerPlugins registered it
            (ctx.manifest.permissions as string[]).length = 0;
            (ctx.manifest.network as string[]).length = 0;
            (ctx.manifest.coreTables as string[]).length = 0;
            (ctx.manifest.configKeys as string[]).length = 0;
            const r = new Hono();
            r.get('/open', (c) => c.json({ ok: true }));
            ctx.route(r, { public: true });
          },
        };

        const infra = makeBaseInfra(dir);
        const app = createCoreApp(infra as any, {
          policy: new SelfHostedPolicy(),
          plugins: [lyingPlugin],
          rawDb: sqlite,
        });

        const listRes = await app.request('http://localhost/api/plugins', {
          headers: { cookie: 'session=tok-owner' },
        });
        const data = (await listRes.json()) as { plugins: Array<Record<string, any>> };
        const view = data.plugins.find((p) => p.id === 'consent-liar');
        expect(view?.permissions).toEqual(['db:own', 'routes:public', 'auth:override']);
        expect(view?.network).toEqual(['evil.example.com']);
        expect(view?.coreTables).toEqual(['invites']);
      } finally {
        sqlite.close();
      }
    });

    it('redacts secrets in logger metadata even when nested deeper than depth 5', () => {
      const secret = 'super-secret-value-123456';
      const secretValues = collectSecretValues({ API_TOKEN: secret });
      const logged: string[] = [];
      const logger = createPluginLogger('deep-log', secretValues, {
        info: (msg) => logged.push(String(msg)),
        warn: () => {},
        error: () => {},
        debug: () => {},
      });

      logger.info('nested', {
        l1: { l2: { l3: { l4: { l5: { l6: { token: secret, raw: secret } } } } } },
      });

      expect(logged.join('\n')).not.toContain(secret);
    });

    it('prevents bypassing per-plugin rate limits with spoofed X-Forwarded-For headers', async () => {
      const { dir, sqlite } = tempSqlite();
      try {
        const plugin: BurrowServerPlugin = {
          manifest: {
            id: 'rl-test',
            version: '0.1.0',
            sdkVersion: '^0.4.0',
            permissions: ['routes:public'],
          },
          setup(ctx) {
            const r = new Hono();
            r.get('/ping', (c) => c.json({ ok: true }));
            ctx.route(r, { public: true });
          },
        };

        const infra = makeBaseInfra(dir);
        const app = createCoreApp(infra as any, {
          policy: new SelfHostedPolicy(),
          plugins: [plugin],
          rawDb: sqlite,
        });

        let got429 = false;
        for (let i = 0; i < 125; i++) {
          const res = await app.request('http://localhost/api/plugins/rl-test/ping', {
            headers: { 'x-forwarded-for': `203.0.113.${i % 250}` },
          });
          if (res.status === 429) {
            got429 = true;
            break;
          }
        }
        expect(got429).toBe(true);
      } finally {
        sqlite.close();
      }
    });

    it('prevents an external plugin from overwriting a first-party adapter override across split loadServerPlugins calls', async () => {
      const { dir, sqlite } = tempSqlite();
      try {
        const firstPartyAuthPlugin: BurrowServerPlugin = {
          manifest: {
            id: 'trusted-auth',
            version: '0.1.0',
            sdkVersion: '^0.4.0',
            permissions: ['auth:override'],
          },
          setup(ctx) {
            ctx.setAdapters({
              auth: {
                getSession: async () => null,
                handler: async () => new Response('trusted'),
              },
            });
          },
        };
        const rogueAuthPlugin: BurrowServerPlugin = {
          manifest: {
            id: 'rogue-auth',
            version: '0.1.0',
            sdkVersion: '^0.4.0',
            permissions: ['auth:override'],
          },
          setup(ctx) {
            ctx.setAdapters({
              auth: {
                getSession: async () => ({ userId: 'u_owner', email: 'spoofed@evil.test' }),
                handler: async () => new Response('rogue'),
              },
            });
          },
        };

        const infra = makeBaseInfra(dir);
        // Should throw collision instead of letting external rogueAuthPlugin silently replace trustedAuthPlugin!
        expect(() =>
          createCoreApp(infra as any, {
            policy: new SelfHostedPolicy(),
            plugins: [firstPartyAuthPlugin, rogueAuthPlugin],
            firstPartyPluginIds: ['trusted-auth'],
            rawDb: sqlite,
          }),
        ).toThrow(/collision/i);
      } finally {
        sqlite.close();
      }
    });

    it('prevents external plugins from claiming built-in id "public-sharing" to disable core sharing routes', async () => {
      const { dir, sqlite } = tempSqlite();
      try {
        const imposter: BurrowServerPlugin = {
          manifest: {
            id: 'public-sharing',
            version: '0.1.0',
            sdkVersion: '^0.4.0',
            permissions: [],
          },
          setup() {},
        };

        const infra = makeBaseInfra(dir);
        expect(() =>
          createCoreApp(infra as any, {
            policy: new SelfHostedPolicy(),
            plugins: [imposter],
            rawDb: sqlite,
          }),
        ).toThrow();
      } finally {
        sqlite.close();
      }
    });

    it('blocks plugin storage writes inside HTTP GET handlers (CSRF / GET-write prevention)', async () => {
      const { dir, sqlite } = tempSqlite();
      try {
        const careless: BurrowServerPlugin = {
          manifest: {
            id: 'get-storage',
            version: '0.1.0',
            sdkVersion: '^0.4.0',
            permissions: ['routes:api', 'storage:own'],
          },
          setup(ctx) {
            const r = new Hono();
            r.get('/mutate', async (c) => {
              await ctx.storage.put('state.txt', 'mutated-on-get', 'text/plain');
              return c.json({ ok: true });
            });
            ctx.route(r);
          },
        };

        const infra = makeBaseInfra(dir);
        const app = createCoreApp(infra as any, {
          policy: new SelfHostedPolicy(),
          plugins: [careless],
          rawDb: sqlite,
        });

        const res = await app.request('http://localhost/api/plugins/get-storage/mutate', {
          headers: { cookie: 'session=tok-owner' },
        });
        expect(res.status).toBeGreaterThanOrEqual(400);
      } finally {
        sqlite.close();
      }
    });

    it('restricts instance-wide plugin toggling to instance owners (unrelated workspace owner cannot toggle global plugins)', async () => {
      const { dir, sqlite } = tempSqlite();
      try {
        const demo: BurrowServerPlugin = {
          manifest: {
            id: 'toggle-target',
            version: '0.1.0',
            sdkVersion: '^0.4.0',
            permissions: ['routes:public'],
          },
          setup(ctx) {
            const r = new Hono();
            r.get('/ping', (c) => c.json({ ok: true }));
            ctx.route(r, { public: true });
          },
        };

        const infra = makeBaseInfra(dir);
        const app = createCoreApp(infra as any, {
          policy: new SelfHostedPolicy(),
          plugins: [demo],
          rawDb: sqlite,
        });

        // u_ws2_owner owns ws2, NOT the instance (isInstanceOwner -> false)
        const toggleRes = await app.request('http://localhost/api/plugins/toggle-target/toggle', {
          method: 'POST',
          headers: {
            cookie: 'session=tok-ws2-owner',
            'content-type': 'application/json',
          },
          body: JSON.stringify({ enabled: false }),
        });
        expect(toggleRes.status).toBe(403);
      } finally {
        sqlite.close();
      }
    });

    it('does not allow arbitrary non-admin authenticated users or zero-workspace outsiders to enumerate plugin configKeys and network hosts', async () => {
      const { dir, sqlite } = tempSqlite();
      try {
        const infra = makeBaseInfra(dir);
        const app = createCoreApp(infra as any, {
          policy: new SelfHostedPolicy(),
          plugins: [
            {
              manifest: {
                id: 'secret-meta',
                version: '0.1.0',
                sdkVersion: '^0.4.0',
                permissions: ['routes:api'],
                configKeys: ['INTERNAL_WEBHOOK_SECRET'],
                network: ['internal-vendor.example.com'],
              },
              setup() {},
            },
          ],
          rawDb: sqlite,
        });

        const outsiderRes = await app.request('http://localhost/api/plugins', {
          headers: { cookie: 'session=tok-outsider' },
        });
        expect(outsiderRes.status).toBe(403);
      } finally {
        sqlite.close();
      }
    });

    it('does not start newly registered third-party plugins as enabled without operator consent', () => {
      const registry = new PluginRuntimeRegistry();
      const rec = registry.register({
        id: 'unconsented',
        version: '0.1.0',
        sdkVersion: '^0.4.0',
        permissions: ['db:own', 'routes:public'],
      });
      expect(rec.enabled).toBe(false);
    });
  });

  describe('Blocked Attacks & Careless Plugin Behavior (expected to pass)', () => {
    it('blocks mountPath override, route collision, missing routes:public permission, and GET/HEAD DB writes', async () => {
      const { dir, sqlite } = tempSqlite();
      try {
        const infra = makeBaseInfra(dir);
        expect(() =>
          createCoreApp(infra as any, {
            policy: new SelfHostedPolicy(),
            plugins: [
              {
                manifest: {
                  id: 'hijacker',
                  version: '0.1.0',
                  sdkVersion: '^0.4.0',
                  permissions: ['routes:api'],
                },
                setup(ctx) {
                  const r = new Hono();
                  r.get('/health', (c) => c.json({ hijacked: true }));
                  ctx.route(r, { mountPath: '/api' });
                },
              },
            ],
            rawDb: sqlite,
          }),
        ).toThrow(/cannot override mountPath/i);

        expect(() =>
          createCoreApp(infra as any, {
            policy: new SelfHostedPolicy(),
            plugins: [
              {
                manifest: {
                  id: 'sneaky-pub',
                  version: '0.1.0',
                  sdkVersion: '^0.4.0',
                  permissions: ['routes:api'],
                },
                setup(ctx) {
                  const r = new Hono();
                  r.get('/open', (c) => c.json({ open: true }));
                  ctx.route(r, { public: true });
                },
              },
            ],
            rawDb: sqlite,
          }),
        ).toThrow(/routes:public/);

        sqlite.exec('CREATE TABLE IF NOT EXISTS plugin_getdb_t (id TEXT PRIMARY KEY)');
        const app = createCoreApp(infra as any, {
          policy: new SelfHostedPolicy(),
          plugins: [
            {
              manifest: {
                id: 'getdb',
                version: '0.1.0',
                sdkVersion: '^0.4.0',
                permissions: ['routes:api', 'db:own'],
              },
              setup(ctx) {
                const r = new Hono();
                r.get('/write', async (c) => {
                  await ctx.db.execute('INSERT INTO plugin_getdb_t (id) VALUES (?)', ['x']);
                  return c.json({ ok: true });
                });
                ctx.route(r);
              },
            },
          ],
          rawDb: sqlite,
        });

        const getWrite = await app.request('http://localhost/api/plugins/getdb/write', {
          headers: { cookie: 'session=tok-owner' },
        });
        expect(getWrite.status).toBe(500);

        const headWrite = await app.request('http://localhost/api/plugins/getdb/write', {
          method: 'HEAD',
          headers: { cookie: 'session=tok-owner' },
        });
        expect(headWrite.status).toBe(500);
      } finally {
        sqlite.close();
      }
    });

    it('enforces requireIdentity, requireWorkspace, and minRole in defineRoute and blocks path normalization tricks', async () => {
      const { dir, sqlite } = tempSqlite();
      try {
        const infra = makeBaseInfra(dir);
        const app = createCoreApp(infra as any, {
          policy: new SelfHostedPolicy(),
          plugins: [
            {
              manifest: {
                id: 'authz-test',
                version: '0.1.0',
                sdkVersion: '^0.4.0',
                permissions: ['routes:api'],
              },
              setup(ctx) {
                ctx.defineRoute({
                  method: 'POST',
                  path: '/workspaces/:wid/items',
                  workspaceParam: 'wid',
                  minRole: 'editor',
                  schemas: {
                    body: z.object({ title: z.string() }),
                  },
                  handler(c: any) {
                    return c.json({ ok: true });
                  },
                });
              },
            },
          ],
          rawDb: sqlite,
        });

        // Unauthenticated
        expect(
          (
            await app.request('http://localhost/api/plugins/authz-test/workspaces/ws1/items', {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({ title: 'x' }),
            })
          ).status,
        ).toBe(401);

        // Cross-workspace IDOR (ws2 owner hitting ws1)
        expect(
          (
            await app.request('http://localhost/api/plugins/authz-test/workspaces/ws1/items', {
              method: 'POST',
              headers: { cookie: 'session=tok-ws2-owner', 'content-type': 'application/json' },
              body: JSON.stringify({ title: 'x' }),
            })
          ).status,
        ).toBe(404);

        // Viewer attempting editor route
        expect(
          (
            await app.request('http://localhost/api/plugins/authz-test/workspaces/ws1/items', {
              method: 'POST',
              headers: { cookie: 'session=tok-viewer', 'content-type': 'application/json' },
              body: JSON.stringify({ title: 'x' }),
            })
          ).status,
        ).toBe(403);

        // Cross-site CSRF blocked
        expect(
          (
            await app.request('http://localhost/api/plugins/authz-test/workspaces/ws1/items', {
              method: 'POST',
              headers: {
                cookie: 'session=tok-owner',
                'sec-fetch-site': 'cross-site',
                'content-type': 'application/json',
              },
              body: JSON.stringify({ title: 'x' }),
            })
          ).status,
        ).toBe(403);

        // Double-slash / trailing slash / case tricks do not bypass auth middleware
        expect(
          (await app.request('http://localhost/api/plugins/authz-test//workspaces/ws1/items', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ title: 'x' }),
          })).status,
        ).toBeGreaterThanOrEqual(401);
        expect(
          (await app.request('http://localhost/api/plugins/AUTHZ-TEST/workspaces/ws1/items', {
            method: 'POST',
          })).status,
        ).toBe(404);
      } finally {
        sqlite.close();
      }
    });

    it('strips CORE_RESERVED_CONFIG_KEYS from ctx.config and redacts them in logger', () => {
      const secret = 'core-auth-secret-should-stay-hidden-32b';
      const { dir, sqlite } = tempSqlite();
      try {
        let seenConfig: Record<string, string | undefined> = {};
        const infra = makeBaseInfra(dir, {
          env: {
            BETTER_AUTH_SECRET: secret,
            MY_PLUGIN_KEY: 'allowed-plugin-key-val',
          },
        });
        createCoreApp(infra as any, {
          policy: new SelfHostedPolicy(),
          plugins: [
            {
              manifest: {
                id: 'cfg-probe',
                version: '0.1.0',
                sdkVersion: '^0.4.0',
                permissions: [],
                configKeys: ['BETTER_AUTH_SECRET', 'MY_PLUGIN_KEY'],
              },
              setup(ctx) {
                seenConfig = { ...ctx.config };
              },
            },
          ],
          rawDb: sqlite,
        });
        expect(seenConfig.BETTER_AUTH_SECRET).toBeUndefined();
        expect(seenConfig.MY_PLUGIN_KEY).toBe('allowed-plugin-key-val');
      } finally {
        sqlite.close();
      }
    });
  });
});

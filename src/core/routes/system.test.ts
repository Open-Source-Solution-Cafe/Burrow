import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Hono } from 'hono';
import {
  buildWebhookDispatchRequest,
  createSystemRoutes,
  detectWebhookProvider,
  isNewerVersion,
  resetReleaseCacheForTests,
  validateSelfUpdateWebhookUrl,
} from './system';

describe('System Version & Update Routes (Milestone 1)', () => {
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    resetReleaseCacheForTests();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it('compares semver strings accurately', () => {
    expect(isNewerVersion('0.2.0', '0.3.0')).toBe(true);
    expect(isNewerVersion('0.2.0', 'v0.2.1')).toBe(true);
    expect(isNewerVersion('0.2.0', '0.2.0')).toBe(false);
    expect(isNewerVersion('1.0.0', '0.9.9')).toBe(false);
  });

  it('falls back to GitHub /tags when /releases/latest returns 404 and respects ?refresh=1', async () => {
    let callCount = 0;
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
      callCount++;
      const url = String(input);
      if (url.includes('/releases/latest')) {
        return new Response('Not Found', { status: 404 });
      }
      if (url.includes('/tags')) {
        return new Response(JSON.stringify([{ name: callCount > 2 ? 'v9.9.9' : 'v9.0.0' }]), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      return new Response('Not Found', { status: 404 });
    }) as typeof fetch;

    const app = new Hono<any>().route(
      '/api/system',
      createSystemRoutes({
        workspaces: {} as any,
        runtime: 'docker-postgres',
      }),
    );

    const res1 = await app.request('/api/system/version');
    expect(res1.status).toBe(200);
    const body1 = (await res1.json()) as any;
    expect(body1.latestVersion).toBe('9.0.0');
    expect(body1.updateAvailable).toBe(true);
    expect(body1.allowSelfUpdate).toBe(true);
    expect(body1.releaseNotesUrl).toContain('/releases/tag/v9.0.0');

    // Cached hit
    const resCached = await app.request('/api/system/version');
    const bodyCached = (await resCached.json()) as any;
    expect(bodyCached.latestVersion).toBe('9.0.0');
    expect(callCount).toBe(2);

    // ?refresh=1 bypasses cache
    const resRefreshed = await app.request('/api/system/version?refresh=1');
    const bodyRefreshed = (await resRefreshed.json()) as any;
    expect(bodyRefreshed.latestVersion).toBe('9.9.9');
    expect(callCount).toBe(4);
  });

  it('skips GitHub check and suppresses updateAvailable when allowSelfUpdate is false', async () => {
    const fetchSpy = vi.fn();
    globalThis.fetch = fetchSpy as typeof fetch;

    const app = new Hono<any>().route(
      '/api/system',
      createSystemRoutes({
        policy: {
          signupMode: () => 'open',
          authorize: async () => {},
          allowSelfUpdate: () => false,
        },
        workspaces: {} as any,
      }),
    );

    const res = await app.request('/api/system/version');
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(body.allowSelfUpdate).toBe(false);
    expect(body.updateAvailable).toBe(false);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('picks the highest SemVer tag, falls back to upstream package.json, and never reports a version older than current', async () => {
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('/releases/latest')) {
        return new Response('Not Found', { status: 404 });
      }
      if (url.includes('/tags')) {
        return new Response(
          JSON.stringify([{ name: 'v0.1.0' }, { name: 'v0.2.0' }, { name: 'not-semver' }]),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      }
      if (url.includes('package.json')) {
        return new Response(JSON.stringify({ version: '9.2.0' }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      return new Response('Not Found', { status: 404 });
    }) as typeof fetch;

    const app = new Hono<any>().route(
      '/api/system',
      createSystemRoutes({ workspaces: {} as any, runtime: 'worker' }),
    );

    const res = await app.request('/api/system/version');
    const body = (await res.json()) as any;
    expect(body.latestVersion).toBe('9.2.0');
    expect(body.updateAvailable).toBe(true);
    expect(body.checkIntervalMinutes).toBe(60);
    expect(typeof body.checkedAt).toBe('string');

    // When upstream feeds only have an older version (e.g. v0.1.0), clamp to currentVersion
    resetReleaseCacheForTests();
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('/releases/latest')) return new Response('Not Found', { status: 404 });
      if (url.includes('/tags')) {
        return new Response(JSON.stringify([{ name: 'v0.1.0' }]), { status: 200 });
      }
      if (url.includes('package.json')) {
        return new Response(JSON.stringify({ version: '0.1.0' }), { status: 200 });
      }
      return new Response('Not Found', { status: 404 });
    }) as typeof fetch;

    const clampedRes = await app.request('/api/system/version?refresh=1');
    const clampedBody = (await clampedRes.json()) as any;
    expect(clampedBody.latestVersion).toBe(clampedBody.currentVersion);
    expect(clampedBody.updateAvailable).toBe(false);
  });

  it('detects GitHub, GitLab, Cloudflare Deploy Hooks, and generic webhooks and surfaces non-OK dispatch errors', async () => {
    expect(detectWebhookProvider('https://gitlab.com/api/v4/projects/123/trigger/pipeline?token=abc&ref=main')).toBe('gitlab');
    expect(detectWebhookProvider('https://api.github.com/repos/owner/repo/dispatches')).toBe('github');
    expect(
      detectWebhookProvider('https://api.cloudflare.com/client/v4/workers/builds/deploy_hooks/hook-123'),
    ).toBe('cloudflare');
    expect(detectWebhookProvider('https://hooks.example.com/redeploy')).toBe('webhook');

    const cfDispatch = buildWebhookDispatchRequest({
      webhookUrl: 'https://api.cloudflare.com/client/v4/workers/builds/deploy_hooks/hook-123',
      webhookToken: 'ignored-token',
      triggeredBy: 'user-1',
      currentVersion: '0.4.0',
      targetVersion: '0.6.6',
    });
    expect(cfDispatch.provider).toBe('cloudflare');
    expect(cfDispatch.headers).toEqual({});
    expect(cfDispatch.body).toBeUndefined();

    const ghDispatch = buildWebhookDispatchRequest({
      webhookUrl: 'https://api.github.com/repos/owner/repo/dispatches',
      webhookToken: 'ghp_secret',
      triggeredBy: 'user-1',
      currentVersion: '0.3.1',
      targetVersion: '0.4.0',
    });
    expect(ghDispatch.headers.Authorization).toBe('Bearer ghp_secret');
    expect(JSON.parse(ghDispatch.body ?? '{}').event_type).toBe('burrow-update');

    const glDispatch = buildWebhookDispatchRequest({
      webhookUrl: 'https://gitlab.com/api/v4/projects/42/trigger/pipeline',
      webhookToken: 'glptt-secret',
      webhookRef: 'main',
      triggeredBy: 'user-1',
      currentVersion: '0.3.1',
      targetVersion: '0.4.0',
    });
    expect(JSON.parse(glDispatch.body ?? '{}')).toEqual({ ref: 'main', token: 'glptt-secret' });

    globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('gitlab.com')) {
        return new Response('Unauthorized', { status: 401 });
      }
      return new Response('Not Found', { status: 404 });
    }) as typeof fetch;

    const app = new Hono<any>()
      .use('*', async (c, next) => {
        c.set('identity', { userId: 'owner-1' });
        await next();
      })
      .route(
        '/api/system',
        createSystemRoutes({
          workspaces: { isInstanceOwner: async () => true } as any,
          env: {
            SELF_UPDATE_WEBHOOK_URL:
              'https://gitlab.com/api/v4/projects/42/trigger/pipeline?token=bad&ref=main',
          },
          runtime: 'worker',
        }),
      );

    const failRes = await app.request('/api/system/update', { method: 'POST' });
    expect(failRes.status).toBe(502);
    const failBody = (await failRes.json()) as any;
    expect(failBody.error.code).toBe('webhook_failed');
    expect(failBody.error.message).toContain('HTTP 401');
  });

  it('rejects insecure or private/internal webhook URLs and disables HTTP redirects on POST /api/system/update', async () => {
    expect(validateSelfUpdateWebhookUrl('http://api.github.com/repos/o/r/dispatches', false).ok).toBe(
      false,
    );
    expect(validateSelfUpdateWebhookUrl('https://127.0.0.1/hook', true).ok).toBe(false);
    expect(validateSelfUpdateWebhookUrl('https://169.254.169.254/latest/meta-data', true).ok).toBe(
      false,
    );
    expect(validateSelfUpdateWebhookUrl('https://user:pass@api.github.com/repos/o/r/dispatches', true).ok).toBe(
      false,
    );
    expect(validateSelfUpdateWebhookUrl('http://127.0.0.1:8080/hook', true).ok).toBe(true);
    expect(validateSelfUpdateWebhookUrl('http://127.0.0.1:8080/hook', false).ok).toBe(false);

    const fetchSpy = vi.fn(async () => new Response(null, { status: 204 })) as unknown as typeof fetch;
    globalThis.fetch = fetchSpy;

    const blockedApp = new Hono<any>()
      .use('*', async (c, next) => {
        c.set('identity', { userId: 'owner-1' });
        await next();
      })
      .route(
        '/api/system',
        createSystemRoutes({
          workspaces: { isInstanceOwner: async () => true } as any,
          env: { SELF_UPDATE_WEBHOOK_URL: 'https://169.254.169.254/latest' },
          runtime: 'worker',
        }),
      );

    const blockedRes = await blockedApp.request('/api/system/update', { method: 'POST' });
    expect(blockedRes.status).toBe(400);
    const blockedBody = (await blockedRes.json()) as any;
    expect(blockedBody.error.code).toBe('invalid_webhook_url');
    expect(fetchSpy).not.toHaveBeenCalled();

    const validApp = new Hono<any>()
      .use('*', async (c, next) => {
        c.set('identity', { userId: 'owner-1' });
        await next();
      })
      .route(
        '/api/system',
        createSystemRoutes({
          workspaces: { isInstanceOwner: async () => true } as any,
          env: { SELF_UPDATE_WEBHOOK_URL: 'https://api.github.com/repos/owner/repo/dispatches' },
          runtime: 'worker',
        }),
      );

    const okRes = await validApp.request('/api/system/update', { method: 'POST' });
    expect(okRes.status).toBe(200);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [, fetchInit] = (fetchSpy as any).mock.calls[0];
    expect(fetchInit.redirect).toBe('error');

    const cfApp = new Hono<any>()
      .use('*', async (c, next) => {
        c.set('identity', { userId: 'owner-1' });
        await next();
      })
      .route(
        '/api/system',
        createSystemRoutes({
          workspaces: { isInstanceOwner: async () => true } as any,
          env: {
            SELF_UPDATE_WEBHOOK_URL:
              'https://api.cloudflare.com/client/v4/workers/builds/deploy_hooks/hook-123',
          },
          runtime: 'worker',
        }),
      );

    const cfRes = await cfApp.request('/api/system/update', { method: 'POST' });
    expect(cfRes.status).toBe(200);
    const cfBody = (await cfRes.json()) as any;
    expect(cfBody.provider).toBe('cloudflare');
    expect(cfBody.message).toContain('Cloudflare Workers Builds');
  });
});

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Hono } from 'hono';
import { createSystemRoutes, isNewerVersion, resetReleaseCacheForTests } from './system';

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
});

import { describe, expect, it, vi, beforeEach } from 'vitest';
import {
  isNewerVersion,
  fetchLatestReleaseVersion,
  resetReleaseCacheForTests,
  createSystemRoutes,
} from '../../src/core/routes/system';
import { APP_VERSION } from '../../src/core/version';
import { SelfHostedPolicy } from '../../src/core/policy';

describe('System Version & Update Logic', () => {
  beforeEach(() => {
    resetReleaseCacheForTests();
    vi.restoreAllMocks();
  });

  describe('isNewerVersion', () => {
    it('detects newer minor and patch releases', () => {
      expect(isNewerVersion('0.1.0', '0.2.0')).toBe(true);
      expect(isNewerVersion('0.1.0', '0.1.1')).toBe(true);
      expect(isNewerVersion('0.1.0', '1.0.0')).toBe(true);
      expect(isNewerVersion('0.1.0', 'v0.2.0')).toBe(true);
    });

    it('rejects older or matching versions', () => {
      expect(isNewerVersion('0.1.0', '0.1.0')).toBe(false);
      expect(isNewerVersion('0.2.0', '0.1.0')).toBe(false);
      expect(isNewerVersion('1.0.0', '0.9.9')).toBe(false);
    });
  });

  describe('fetchLatestReleaseVersion', () => {
    it('fetches release tag and strips v prefix', async () => {
      const fetchMock = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ tag_name: 'v0.3.0' }),
      });
      vi.stubGlobal('fetch', fetchMock);

      const latest = await fetchLatestReleaseVersion(APP_VERSION);
      expect(latest).toBe('0.3.0');
      expect(fetchMock).toHaveBeenCalledTimes(1);

      // Cached on subsequent call within TTL
      const cached = await fetchLatestReleaseVersion(APP_VERSION);
      expect(cached).toBe('0.3.0');
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it('falls back silently to currentVersion on network or API failure', async () => {
      const fetchMock = vi.fn().mockRejectedValue(new Error('Connection refused'));
      vi.stubGlobal('fetch', fetchMock);

      const latest = await fetchLatestReleaseVersion('0.1.0');
      expect(latest).toBe('0.1.0');
    });
  });

  describe('System routes endpoint handling', () => {
    it('GET /version returns current version, update status, and allowSelfUpdate', async () => {
      const workspaces = {
        listByUser: vi.fn().mockResolvedValue([]),
      } as any;
      const routes = createSystemRoutes({
        policy: new SelfHostedPolicy(),
        workspaces,
      });

      const res = await routes.request('http://localhost/version');
      expect(res.status).toBe(200);
      const data = (await res.json()) as any;
      expect(data.currentVersion).toBe(APP_VERSION);
      expect(typeof data.latestVersion).toBe('string');
      expect(typeof data.updateAvailable).toBe('boolean');
      expect(data.allowSelfUpdate).toBe(true);
    });

    it('POST /update rejects unauthenticated requests', async () => {
      const workspaces = {
        listByUser: vi.fn().mockResolvedValue([]),
      } as any;
      const routes = createSystemRoutes({
        policy: new SelfHostedPolicy(),
        workspaces,
      });

      const res = await routes.request('http://localhost/update', { method: 'POST' });
      expect(res.status).toBe(401);
    });

    it('POST /update rejects non-owners', async () => {
      const workspaces = {
        listByUser: vi.fn().mockResolvedValue([{ id: 'w1', role: 'viewer' }]),
      } as any;
      const routes = createSystemRoutes({
        policy: new SelfHostedPolicy(),
        workspaces,
      });

      // Test with custom app context dispatching through Hono
      const app = new (await import('hono')).Hono<any>();
      app.use('*', async (ctx, next) => {
        ctx.set('identity', { userId: 'u1' });
        await next();
      });
      app.route('/', routes);

      const res = await app.request('http://localhost/update', { method: 'POST' });
      expect(res.status).toBe(403);
      const body = (await res.json()) as any;
      expect(body.error.code).toBe('forbidden');
    });

    it('POST /update triggers webhook if configured', async () => {
      const workspaces = {
        listByUser: vi.fn().mockResolvedValue([{ id: 'w1', role: 'owner' }]),
      } as any;
      const fetchMock = vi.fn().mockResolvedValue({ status: 200 });
      vi.stubGlobal('fetch', fetchMock);

      const routes = createSystemRoutes({
        policy: new SelfHostedPolicy(),
        workspaces,
        env: { SELF_UPDATE_WEBHOOK_URL: 'https://example.com/update-hook' },
      });

      const app = new (await import('hono')).Hono<any>();
      app.use('*', async (ctx, next) => {
        ctx.set('identity', { userId: 'owner-1' });
        await next();
      });
      app.route('/', routes);

      const res = await app.request('http://localhost/update', { method: 'POST' });
      expect(res.status).toBe(200);
      const body = (await res.json()) as any;
      expect(body.ok).toBe(true);
      expect(body.status).toBe('triggered');
      expect(fetchMock).toHaveBeenCalledWith('https://example.com/update-hook', expect.anything());
    });
  });
});

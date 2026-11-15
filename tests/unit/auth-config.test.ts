import { describe, expect, it, vi } from 'vitest';
import { createCoreApp } from '../../src/core/app';
import { InMemoryRateLimitStore } from '../../src/core/adapters/rate-limit';
import { SelfHostedPolicy } from '../../src/core/policy';
import { createWorkerApp } from '../../src/worker';

function createMockInfra(overrides: Partial<any> = {}) {
  return {
    repositories: {
      workspaces: {
        listByUser: vi.fn().mockResolvedValue([]),
        create: vi.fn().mockResolvedValue({ id: 'ws-new', name: 'My Workspace' }),
        count: vi.fn().mockResolvedValue(0),
      },
      members: {
        findByUserId: vi.fn().mockResolvedValue(null),
        listByWorkspace: vi.fn().mockResolvedValue([]),
      },
      projects: {},
      notepads: {},
      projectFiles: {},
      boards: {},
      cards: {},
      tags: {},
      notifications: {},
      invites: {},
    },
    storage: {},
    search: {},
    locks: {},
    auth: {
      getSession: vi.fn().mockResolvedValue({ userId: 'u1', email: 'test@example.com' }),
      handler: vi.fn().mockResolvedValue(new Response('ok')),
    },
    email: {
      provider: 'console',
      send: vi.fn(),
    },
    bootstrapToken: 'valid-test-bootstrap-token',
    env: {},
    ...overrides,
  } as any;
}

describe('Auth Config & Auto-Workspace Provisioning', () => {
  it('GET /api/auth/config returns neutral structure with console email fallback', async () => {
    const infra = createMockInfra();
    const app = createCoreApp(infra);

    const res = await app.request('http://localhost/api/auth/config');
    expect(res.status).toBe(200);
    const data = (await res.json()) as any;
    expect(data.signupMode).toBe('bootstrap-or-invite');
    expect(data.emailPasswordEnabled).toBe(true);
    expect(data.magicLinkEnabled).toBe(false);
    expect(data.oauthProviders).toEqual([]);
  });

  it('GET /api/auth/config enables magic link and oauth when configured', async () => {
    const infra = createMockInfra({
      email: { provider: 'resend', send: vi.fn() },
      env: {
        GOOGLE_CLIENT_ID: 'google-client-id-123',
        GITHUB_CLIENT_ID: 'github-client-id-456',
        RESEND_API_KEY: 're_12345',
      },
    });
    const app = createCoreApp(infra);

    const res = await app.request('http://localhost/api/auth/config');
    expect(res.status).toBe(200);
    const data = (await res.json()) as any;
    expect(data.magicLinkEnabled).toBe(true);
    expect(data.oauthProviders).toEqual([
      { id: 'google', name: 'Google', kind: 'social' },
      { id: 'github', name: 'GitHub', kind: 'social' },
    ]);
  });

  it('GET /api/account auto-creates initial workspace in open signup mode', async () => {
    class OpenPolicy extends SelfHostedPolicy {
      override signupMode(): 'open' {
        return 'open';
      }
    }

    const infra = createMockInfra();
    const app = createCoreApp(infra, { policy: new OpenPolicy() });

    const headers = new Headers();
    headers.set('Cookie', 'better-auth.session_token=test-token');

    const res = await app.request('http://localhost/api/account', { headers });
    expect(res.status).toBe(200);
    expect(infra.repositories.workspaces.create).toHaveBeenCalledTimes(1);
  });

  it('forwards Cloudflare Worker OAuth and update webhook bindings in createWorkerApp (#006)', async () => {
    const workerApp = createWorkerApp({
      DB: {} as any,
      FILES: {} as any,
      BETTER_AUTH_SECRET: 'worker-test-secret-minimum-32-characters!!',
      BETTER_AUTH_URL: 'https://worker.example.com',
      BOOTSTRAP_TOKEN: 'worker-bootstrap-token-16chars',
      GOOGLE_CLIENT_ID: 'worker-google-id',
      GOOGLE_CLIENT_SECRET: 'worker-google-secret',
      GITHUB_CLIENT_ID: 'worker-github-id',
      GITHUB_CLIENT_SECRET: 'worker-github-secret',
      SELF_UPDATE_WEBHOOK_URL: 'https://hooks.example.com/update',
    });

    const cfgRes = await workerApp.request('https://worker.example.com/api/auth/config');
    expect(cfgRes.status).toBe(200);
    const data = (await cfgRes.json()) as any;
    expect(data.oauthProviders).toEqual([
      { id: 'google', name: 'Google', kind: 'social' },
      { id: 'github', name: 'GitHub', kind: 'social' },
    ]);
  });

  it('enforces per-key limits in Better Auth customStorage adapter (#009)', async () => {
    const store = new InMemoryRateLimitStore();
    const storage = store.createBetterAuthStorage();
    const rule = { window: 10, max: 3 };

    for (let i = 0; i < 3; i += 1) {
      expect(await storage.consume('ip:198.51.100.1|/sign-in/email', rule)).toEqual({
        allowed: true,
        retryAfter: null,
      });
    }
    const blocked = await storage.consume('ip:198.51.100.1|/sign-in/email', rule);
    expect(blocked.allowed).toBe(false);
    expect(blocked.retryAfter).toBeGreaterThanOrEqual(1);

    // Distinct key remains isolated and allowed
    expect(await storage.consume('ip:198.51.100.2|/sign-in/email', rule)).toEqual({
      allowed: true,
      retryAfter: null,
    });
  });
});

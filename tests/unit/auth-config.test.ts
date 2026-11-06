import { describe, expect, it, vi } from 'vitest';
import { createCoreApp } from '../../src/core/app';
import { SelfHostedPolicy } from '../../src/core/policy';

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
});

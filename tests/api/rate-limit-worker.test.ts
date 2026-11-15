import { env } from 'cloudflare:test';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createWorkerApp } from '../../src/worker/index';
import { getAccountWorkspaceScope } from './account-scope';

const bootstrapToken = env.BOOTSTRAP_TOKEN || 'test-bootstrap-token';

/** Instantiate a brand-new Worker Hono application on every request (real Worker lifecycle). */
function invokeFreshWorker(
  path: string,
  init: RequestInit = {},
  options: { cfColo?: string; db?: D1Database } = {},
) {
  const workerEnv = options.db ? { ...env, DB: options.db } : env;
  const app = createWorkerApp(workerEnv);
  const req = new Request(`http://localhost${path}`, init);
  if (options.cfColo) {
    Object.defineProperty(req, 'cf', { value: { colo: options.cfColo }, configurable: true });
  }
  return app.request(req, undefined, workerEnv);
}

function postJsonFresh(
  path: string,
  body: unknown,
  options: {
    cookie?: string;
    headers?: Record<string, string>;
    cfColo?: string;
    db?: D1Database;
  } = {},
) {
  const headers = new Headers(options.headers);
  headers.set('Content-Type', 'application/json');
  if (options.cookie) headers.set('Cookie', options.cookie);
  return invokeFreshWorker(
    path,
    {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
    },
    { cfColo: options.cfColo, db: options.db },
  );
}

describe('Worker persistent rate limiting and proxy trust across fresh app instances', () => {
  let ownerCookie = '';
  let workspaceId = '';

  const aliceEmail = 'rl-alice@example.com';
  const bobEmail = 'rl-bob@example.com';
  const carolEmail = 'rl-carol@example.com';
  const daveEmail = 'rl-dave@example.com';

  beforeAll(async () => {
    const ownerRes = await postJsonFresh('/api/auth/sign-up/email', {
      email: aliceEmail,
      password: 'password123',
      name: 'Alice RL',
      bootstrapToken,
    });
    expect(ownerRes.status).toBe(200);
    ownerCookie = ownerRes.headers.get('set-cookie')!;

    const scope = await getAccountWorkspaceScope((path) =>
      invokeFreshWorker(path, { headers: { Cookie: ownerCookie } }),
    );
    workspaceId = scope.workspaceId;

    for (const [email, name] of [
      [bobEmail, 'Bob RL'],
      [carolEmail, 'Carol RL'],
      [daveEmail, 'Dave RL'],
    ] as const) {
      const inviteRes = await postJsonFresh(
        `/api/workspaces/${workspaceId}/invites`,
        { email, role: 'editor' },
        { cookie: ownerCookie },
      );
      expect(inviteRes.status).toBe(200);
      const { token } = (await inviteRes.json()) as { token: string };
      const signupRes = await postJsonFresh('/api/auth/sign-up/email', {
        email,
        password: 'password123',
        name,
        inviteToken: token,
      });
      expect(signupRes.status).toBe(200);
    }
  });

  beforeEach(async () => {
    await env.DB.prepare('DELETE FROM rate_limits').run();
  });

  it('persists strict sign-in limits across separate Worker instances and blocks spoofed forwarding header rotation', async () => {
    for (let i = 0; i < 3; i += 1) {
      const res = await postJsonFresh(
        '/api/auth/sign-in/email',
        { email: aliceEmail, password: 'wrong-password' },
        {
          headers: {
            'CF-Connecting-IP': `198.51.100.${i + 1}`,
            'X-Forwarded-For': `203.0.113.${i + 1}`,
          },
        },
      );
      expect(res.status).toBe(401);
    }

    // 4th attempt on a fresh Worker instance with yet another spoofed header must STILL 429
    const blocked = await postJsonFresh(
      '/api/auth/sign-in/email',
      { email: aliceEmail, password: 'wrong-password' },
      {
        headers: {
          'CF-Connecting-IP': '198.51.100.250',
          'X-Forwarded-For': '203.0.113.250',
        },
      },
    );
    expect(blocked.status).toBe(429);

    // Confirm rate_limits row persisted in D1 across isolate invocations
    const persisted = await env.DB.prepare('SELECT key, count FROM rate_limits').all<{
      key: string;
      count: number;
    }>();
    expect(persisted.results.length).toBeGreaterThanOrEqual(1);
    expect(persisted.results.some((r) => r.count >= 3)).toBe(true);
  });

  it('does not share an unintended global auth bucket between different users (unverified or behind shared edge IP)', async () => {
    // Exhaust Alice without verified CF metadata
    for (let i = 0; i < 3; i += 1) {
      await postJsonFresh('/api/auth/sign-in/email', {
        email: aliceEmail,
        password: 'wrong-password',
      });
    }
    const aliceBlocked = await postJsonFresh('/api/auth/sign-in/email', {
      email: aliceEmail,
      password: 'password123',
    });
    expect(aliceBlocked.status).toBe(429);

    // Bob signs in immediately on a fresh Worker instance and is NOT blocked by Alice's bucket
    const bobSuccess = await postJsonFresh('/api/auth/sign-in/email', {
      email: bobEmail,
      password: 'password123',
    });
    expect(bobSuccess.status).toBe(200);

    // Now test behind the same verified Cloudflare edge client IP (NAT / corporate proxy)
    for (let i = 0; i < 3; i += 1) {
      await postJsonFresh(
        '/api/auth/sign-in/email',
        { email: carolEmail, password: 'wrong-password' },
        { cfColo: 'IAD', headers: { 'CF-Connecting-IP': '198.51.100.88' } },
      );
    }
    const carolBlocked = await postJsonFresh(
      '/api/auth/sign-in/email',
      { email: carolEmail, password: 'password123' },
      { cfColo: 'IAD', headers: { 'CF-Connecting-IP': '198.51.100.88' } },
    );
    expect(carolBlocked.status).toBe(429);

    const daveSuccess = await postJsonFresh(
      '/api/auth/sign-in/email',
      { email: daveEmail, password: 'password123' },
      { cfColo: 'IAD', headers: { 'CF-Connecting-IP': '198.51.100.88' } },
    );
    expect(daveSuccess.status).toBe(200);
  });

  it('persists strict sign-up limits across separate Worker instances', async () => {
    const targetEmail = 'rl-signup-abuse@example.com';
    for (let i = 0; i < 3; i += 1) {
      const res = await postJsonFresh('/api/auth/sign-up/email', {
        email: targetEmail,
        password: 'password123',
        name: 'Abuse Test',
      });
      expect(res.status).not.toBe(429);
    }
    const fourth = await postJsonFresh('/api/auth/sign-up/email', {
      email: targetEmail,
      password: 'password123',
      name: 'Abuse Test',
    });
    expect(fourth.status).toBe(429);
  });

  it('persists invite read and create rate limits across separate Worker instances despite header rotation', async () => {
    let hit429OnGet = false;
    for (let i = 0; i < 35; i += 1) {
      const res = await invokeFreshWorker(`/api/invites/info/nonexistent-token-${i}`, {
        headers: {
          'CF-Connecting-IP': `198.51.100.${(i % 200) + 1}`,
          'X-Forwarded-For': `203.0.113.${(i % 200) + 1}`,
        },
      });
      if (res.status === 429) {
        hit429OnGet = true;
        break;
      }
      expect(res.status).toBe(404);
    }
    expect(hit429OnGet).toBe(true);

    let hit429OnCreate = false;
    for (let i = 0; i < 25; i += 1) {
      const res = await postJsonFresh(
        `/api/workspaces/${workspaceId}/invites`,
        { email: `invite-burst-${i}@example.com`, role: 'viewer' },
        {
          cookie: ownerCookie,
          headers: {
            'CF-Connecting-IP': `192.0.2.${i + 1}`,
            'X-Forwarded-For': `198.51.100.${i + 1}`,
          },
        },
      );
      if (res.status === 429) {
        hit429OnCreate = true;
        break;
      }
      expect(res.status).toBe(200);
    }
    expect(hit429OnCreate).toBe(true);
  });

  it('fails closed with HTTP 503 when rate_limits database queries fail (no in-memory fallback)', async () => {
    const failingRateLimitDb = new Proxy(env.DB, {
      get(target, prop, receiver) {
        if (prop === 'prepare') {
          return (query: string) => {
            if (query.toLowerCase().includes('rate_limits')) {
              return {
                bind() {
                  return {
                    async run() {
                      throw new Error('simulated D1 rate_limits outage');
                    },
                    async all() {
                      throw new Error('simulated D1 rate_limits outage');
                    },
                    async first() {
                      throw new Error('simulated D1 rate_limits outage');
                    },
                  };
                },
                async run() {
                  throw new Error('simulated D1 rate_limits outage');
                },
                async all() {
                  throw new Error('simulated D1 rate_limits outage');
                },
              };
            }
            return target.prepare(query);
          };
        }
        return Reflect.get(target, prop, receiver);
      },
    }) as D1Database;

    const signInRes = await postJsonFresh(
      '/api/auth/sign-in/email',
      { email: aliceEmail, password: 'password123' },
      { db: failingRateLimitDb },
    );
    expect(signInRes.status).toBe(503);

    const signUpRes = await postJsonFresh(
      '/api/auth/sign-up/email',
      { email: 'outage-signup@example.com', password: 'password123', name: 'Outage' },
      { db: failingRateLimitDb },
    );
    expect(signUpRes.status).toBe(503);

    const inviteReadRes = await invokeFreshWorker('/api/invites/info/any-token', undefined, {
      db: failingRateLimitDb,
    });
    expect(inviteReadRes.status).toBe(503);

    const inviteCreateRes = await postJsonFresh(
      `/api/workspaces/${workspaceId}/invites`,
      { email: 'outage-invite@example.com', role: 'viewer' },
      { cookie: ownerCookie, db: failingRateLimitDb },
    );
    expect(inviteCreateRes.status).toBe(503);

    const recoverRes = await postJsonFresh(
      '/api/auth/bootstrap/recover',
      { bootstrapToken, resetClaim: true },
      { db: failingRateLimitDb },
    );
    expect(recoverRes.status).toBe(503);
  });
});

import { env } from 'cloudflare:test';
import { expect, it } from 'vitest';
import { createWorkerApp } from '../../src/worker';
import { createD1Infrastructure } from '../../src/core/adapters/db/d1';
import { createDb } from '../../src/core/adapters/db/d1/client';

it('reserves one bootstrap account and recovers the same starter workspace after provisioning fails', async () => {
  const app = createWorkerApp(env);
  const token = env.BOOTSTRAP_TOKEN || 'test-bootstrap-token';
  const password = 'bootstrap-password-123';
  const emails = ['bootstrap-a@example.test', 'bootstrap-b@example.test'];
  const post = (path: string, body: unknown, cookie?: string) => {
    const headers = new Headers({ 'Content-Type': 'application/json' });
    if (cookie) headers.set('Cookie', cookie);
    return app.request(
      `http://localhost${path}`,
      { method: 'POST', headers, body: JSON.stringify(body) },
      env,
    );
  };
  const count = async (table: string) => {
    const row = await env.DB.prepare(`SELECT count(*) AS count FROM ${table}`).first<{
      count: number;
    }>();
    return row!.count;
  };

  // Fail only the domain transaction, after BetterAuth has created the account.
  await env.DB.prepare(
    "CREATE TRIGGER fail_bootstrap_workspace BEFORE INSERT ON workspaces BEGIN SELECT RAISE(ABORT, 'forced_bootstrap_failure'); END",
  ).run();
  try {
    const attempts = await Promise.all(
      emails.map((email) =>
        post('/api/auth/sign-up/email', {
          name: 'Bootstrap owner',
          email,
          password,
          bootstrapToken: token,
        }),
      ),
    );
    expect(attempts.every((response) => !response.ok)).toBe(true);
    for (const response of attempts) {
      expect(response.headers.get('set-cookie')).toBeNull();
      const body = await response.text();
      expect(body).not.toContain(token);
      expect(body).not.toContain(password);
    }
    const accounts = (await env.DB.prepare('SELECT email FROM "user"').all<{ email: string }>())
      .results;
    expect(accounts).toHaveLength(1);
    expect(emails).toContain(accounts[0]!.email);
    expect(await count('workspaces')).toBe(0);
    expect(await count('members')).toBe(0);
    expect(await count('projects')).toBe(0);
    expect(await count('notepads')).toBe(0);

    const signIn = await post('/api/auth/sign-in/email', { email: accounts[0]!.email, password });
    expect(signIn.status).toBe(200);
    const cookie = signIn.headers.get('set-cookie');
    expect(cookie).toBeTruthy();
    const account = await app.request(
      'http://localhost/api/account',
      { headers: { Cookie: cookie! } },
      env,
    );
    expect(account.status).toBe(200);
    expect(await account.json()).toMatchObject({
      user: { email: accounts[0]!.email },
      workspaces: [],
    });
    const anonymous = await post('/api/auth/bootstrap/recover', { bootstrapToken: token });
    expect(anonymous.status).toBe(401);
    const wrongToken = await post(
      '/api/auth/bootstrap/recover',
      { bootstrapToken: 'incorrect-bootstrap-token' },
      cookie!,
    );
    expect(wrongToken.status).toBe(403);
    expect(await count('workspaces')).toBe(0);

    // Simulate an unrelated pre-existing authenticated account directly in the auth provider.
    const auth = createD1Infrastructure(createDb(env.DB), env).auth;
    const unrelated = await auth.handler(
      new Request('http://localhost/api/auth/sign-up/email', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'Other', email: 'unrelated@example.test', password }),
      }),
    );
    expect(unrelated.status).toBe(200);
    const unrelatedCookie = unrelated.headers.get('set-cookie');
    expect(unrelatedCookie).toBeTruthy();
    const wrongAccount = await post(
      '/api/auth/bootstrap/recover',
      { bootstrapToken: token },
      unrelatedCookie!,
    );
    expect(wrongAccount.ok).toBe(false);
    expect(await count('workspaces')).toBe(0);

    await env.DB.prepare('DROP TRIGGER fail_bootstrap_workspace').run();
    const recover = await post('/api/auth/bootstrap/recover', { bootstrapToken: token }, cookie!);
    expect(recover.status).toBe(200);
    const first = (await recover.json()) as { workspaceId: string };
    expect(first.workspaceId).toBeTruthy();
    const replay = await post('/api/auth/bootstrap/recover', { bootstrapToken: token }, cookie!);
    expect(replay.status).toBe(200);
    expect(await replay.json()).toMatchObject({ workspaceId: first.workspaceId });
    expect(await count('workspaces')).toBe(1);
    expect(await count('members')).toBe(1);
    expect(await count('projects')).toBe(1);
    expect(await count('notepads')).toBe(1);
    const another = await post('/api/auth/sign-up/email', {
      name: 'Late claimant',
      email: 'late@example.test',
      password,
      bootstrapToken: token,
    });
    expect(another.status).toBe(403);
    expect(await count('workspaces')).toBe(1);
  } finally {
    await env.DB.prepare('DROP TRIGGER IF EXISTS fail_bootstrap_workspace').run();
  }
});

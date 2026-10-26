import { env } from 'cloudflare:test';
import { beforeAll, describe, expect, it } from 'vitest';
import { createWorkerApp } from '../../src/worker/index';

describe('Invites info and existing user flow API contract', () => {
  const bootstrapToken = env.BOOTSTRAP_TOKEN || 'test-bootstrap-token';
  let ownerCookie = '';
  let app: ReturnType<typeof createWorkerApp>;

  beforeAll(async () => {
    app = createWorkerApp(env);

    // 1. Initial workspace owner signup
    const signupRes = await app.request(
      'http://localhost/api/auth/sign-up/email',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          email: 'owner-invites-info@example.com',
          password: 'password123',
          name: 'Owner Info User',
          bootstrapToken,
        }),
      },
      env,
    );
    expect(signupRes.status).toBe(200);
    ownerCookie = signupRes.headers.get('set-cookie')!;
  });

  it('GET /api/invites/info/:token returns userExists: false for new unregistered users', async () => {
    // Create invite for uncreated user
    const createRes = await app.request(
      'http://localhost/api/invites',
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Cookie: ownerCookie,
        },
        body: JSON.stringify({
          email: 'brand-new-user@example.com',
          role: 'viewer',
        }),
      },
      env,
    );
    expect(createRes.status).toBe(200);
    const createData = (await createRes.json()) as { token: string; email: string };

    // Query invite info
    const infoRes = await app.request(
      `http://localhost/api/invites/info/${createData.token}`,
      { method: 'GET' },
      env,
    );
    expect(infoRes.status).toBe(200);
    const info = (await infoRes.json()) as {
      valid: boolean;
      token: string;
      email: string;
      role: string;
      workspaceName: string;
      userExists: boolean;
    };

    expect(info.valid).toBe(true);
    expect(info.token).toBe(createData.token);
    expect(info.email).toBe('brand-new-user@example.com');
    expect(info.role).toBe('viewer');
    expect(info.workspaceName).toBeDefined();
    expect(info.userExists).toBe(false);
  });

  it('GET /api/invites/info/:token returns userExists: true when user account exists in system', async () => {
    // 1. Register a user first via an invite
    const invite1Res = await app.request(
      'http://localhost/api/invites',
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Cookie: ownerCookie,
        },
        body: JSON.stringify({
          email: 'existing-member-to-reinvite@example.com',
          role: 'editor',
        }),
      },
      env,
    );
    expect(invite1Res.status).toBe(200);
    const { token: token1 } = (await invite1Res.json()) as { token: string };

    // Sign up the user
    const userSignupRes = await app.request(
      'http://localhost/api/auth/sign-up/email',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          email: 'existing-member-to-reinvite@example.com',
          password: 'password123',
          name: 'Existing Member',
          inviteToken: token1,
        }),
      },
      env,
    );
    expect(userSignupRes.status).toBe(200);
    const userData = (await userSignupRes.json()) as { user: { id: string } };

    // Remove member from workspace so they have no workspace (existing user in user table, not in members)
    const removeRes = await app.request(
      `http://localhost/api/members/${userData.user.id}`,
      {
        method: 'DELETE',
        headers: {
          Cookie: ownerCookie,
        },
      },
      env,
    );
    expect(removeRes.status).toBe(200);

    // 2. Owner invites this existing user again
    const invite2Res = await app.request(
      'http://localhost/api/invites',
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Cookie: ownerCookie,
        },
        body: JSON.stringify({
          email: 'existing-member-to-reinvite@example.com',
          role: 'editor',
        }),
      },
      env,
    );
    expect(invite2Res.status).toBe(200);
    const { token: token2 } = (await invite2Res.json()) as { token: string };

    // 3. GET /api/invites/info/:token should report userExists: true
    const info2Res = await app.request(
      `http://localhost/api/invites/info/${token2}`,
      { method: 'GET' },
      env,
    );
    expect(info2Res.status).toBe(200);
    const info2 = (await info2Res.json()) as {
      valid: boolean;
      userExists: boolean;
      email: string;
    };
    expect(info2.valid).toBe(true);
    expect(info2.userExists).toBe(true);
    expect(info2.email).toBe('existing-member-to-reinvite@example.com');

    // 4. Existing user signs in and accepts the invite via /api/invites/accept
    const signinRes = await app.request(
      'http://localhost/api/auth/sign-in/email',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          email: 'existing-member-to-reinvite@example.com',
          password: 'password123',
        }),
      },
      env,
    );
    expect(signinRes.status).toBe(200);
    const sessionCookie = signinRes.headers.get('set-cookie')!;

    // Accept invite
    const acceptRes = await app.request(
      'http://localhost/api/invites/accept',
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Cookie: sessionCookie,
        },
        body: JSON.stringify({ token: token2 }),
      },
      env,
    );
    expect(acceptRes.status).toBe(200);
    const acceptData = (await acceptRes.json()) as { ok: boolean; role: string };
    expect(acceptData.ok).toBe(true);
    expect(acceptData.role).toBe('editor');

    // 5. Subsequent attempt to accept the now-consumed token returns 400
    const reAcceptRes = await app.request(
      'http://localhost/api/invites/accept',
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Cookie: sessionCookie,
        },
        body: JSON.stringify({ token: token2 }),
      },
      env,
    );
    expect(reAcceptRes.status).toBe(400);
  });
});

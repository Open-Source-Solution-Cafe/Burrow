import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { createCoreApp } from '../../src/core/app';
import { createD1Infrastructure } from '../../src/core/adapters/db/d1';
import { createDb } from '../../src/core/adapters/db/d1/client';
import type { AccessPolicy, PolicyContext, SignupMode } from '../../src/core/policy';
import { httpError, type HttpError } from '../../src/core/services/errors';
import { getAccountWorkspaceScope } from './account-scope';

class TestAccessPolicy implements AccessPolicy {
  currentMode: SignupMode = 'bootstrap-or-invite';
  denyActions = new Set<string>();
  throwCustomQuotaError = false;

  signupMode(): SignupMode {
    return this.currentMode;
  }

  async authorize(ctx: PolicyContext): Promise<void> {
    if (this.throwCustomQuotaError) {
      throw new Error('MOCK_DB_QUOTA_TRIGGER: disk limit exceeded');
    }

    if (this.denyActions.has(ctx.action)) {
      if (
        ctx.action === 'workspace.create' ||
        ctx.action === 'member.add' ||
        ctx.action === 'file.upload'
      ) {
        throw httpError(402, 'payment_required', `Policy denied ${ctx.action}`);
      }
      throw httpError(403, 'forbidden', `Policy denied ${ctx.action}`);
    }
  }

  mapError(error: unknown): HttpError | null {
    if (
      error instanceof Error &&
      error.message.includes('MOCK_DB_QUOTA_TRIGGER')
    ) {
      return httpError(402, 'quota_exhausted', 'Database quota trigger violation');
    }
    return null;
  }
}

describe('AccessPolicy Contract', () => {
  const policy = new TestAccessPolicy();
  const db = createDb(env.DB);
  const testEnv = env as any;
  const infra = createD1Infrastructure(db, {
    FILES: env.FILES,
    BETTER_AUTH_SECRET: env.BETTER_AUTH_SECRET,
    BETTER_AUTH_URL: env.BETTER_AUTH_URL,
    BOOTSTRAP_TOKEN: env.BOOTSTRAP_TOKEN,
    RESEND_API_KEY: testEnv.RESEND_API_KEY,
    EMAIL_FROM: testEnv.EMAIL_FROM,
  });
  const app = createCoreApp(infra, { policy });

  const request = (path: string, cookie = '', init: RequestInit = {}) => {
    const headers = new Headers(init.headers);
    if (cookie) headers.set('Cookie', cookie);
    return app.request(`http://localhost${path}`, { ...init, headers }, env);
  };

  const postJson = (path: string, body: unknown, cookie = '') =>
    request(path, cookie, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });

  it('exposes /api/ready and /api/auth/config', async () => {
    const readyRes = await request('/api/ready');
    expect(readyRes.status).toBe(200);
    const readyData = (await readyRes.json()) as { ready: boolean; now: number };
    expect(readyData.ready).toBe(true);
    expect(typeof readyData.now).toBe('number');

    const configRes = await request('/api/auth/config');
    expect(configRes.status).toBe(200);
    const configData = (await configRes.json()) as { signupMode: SignupMode };
    expect(configData.signupMode).toBe('bootstrap-or-invite');

    policy.currentMode = 'open';
    const openConfigRes = await request('/api/auth/config');
    expect(openConfigRes.status).toBe(200);
    expect((await openConfigRes.json()) as { signupMode: SignupMode }).toMatchObject({
      signupMode: 'open',
    });
    policy.currentMode = 'bootstrap-or-invite';
  });

  it('supports initial bootstrap sign-up in bootstrap-or-invite mode', async () => {
    policy.currentMode = 'bootstrap-or-invite';

    // Sign up initial owner with bootstrap token
    const ownerRes = await postJson('/api/auth/sign-up/email', {
      email: 'bootstrap-owner@example.test',
      password: 'password123',
      name: 'Bootstrap Owner',
      bootstrapToken: env.BOOTSTRAP_TOKEN || 'test-bootstrap-token',
    });
    expect(ownerRes.status).toBe(200);
    const ownerCookie = ownerRes.headers.get('set-cookie')!;
    expect(ownerCookie).toBeTruthy();

    const scope = await getAccountWorkspaceScope((path) => request(path, ownerCookie));
    expect(scope.workspaceId).toBeTruthy();

    // Subsequent signup without invite in bootstrap-or-invite mode must be rejected with 403 invite_required
    const uninvitedRes = await postJson('/api/auth/sign-up/email', {
      email: 'uninvited@example.test',
      password: 'password123',
      name: 'Uninvited User',
    });
    expect(uninvitedRes.status).toBe(403);
    expect(await uninvitedRes.json()).toEqual({
      error: { code: 'invite_required', message: 'Invite token is required to register' },
    });
  });

  it('supports open signupMode: allows registration & workspace creation without bootstrap or invite token', async () => {
    policy.currentMode = 'open';

    const signupRes = await postJson('/api/auth/sign-up/email', {
      email: 'open-policy-user@example.test',
      password: 'password123',
      name: 'Open User',
    });
    expect(signupRes.status).toBe(200);
    const cookie = signupRes.headers.get('set-cookie')!;
    expect(cookie).toBeTruthy();

    const scope = await getAccountWorkspaceScope((path) => request(path, cookie));
    expect(scope.userId).toBeTruthy();
    expect(scope.workspaceId).toBeTruthy();
    expect(scope.projectId).toBeTruthy();

    policy.currentMode = 'bootstrap-or-invite';
  });

  it('denies domain actions and prevents writes when policy rejects', async () => {
    // Register owner using open mode
    policy.currentMode = 'open';
    const ownerRes = await postJson('/api/auth/sign-up/email', {
      email: 'policy-owner@example.test',
      password: 'password123',
      name: 'Policy Owner',
    });
    expect(ownerRes.status).toBe(200);
    const ownerCookie = ownerRes.headers.get('set-cookie')!;
    policy.currentMode = 'bootstrap-or-invite';

    const scope = await getAccountWorkspaceScope((path) => request(path, ownerCookie));
    const { workspaceId, projectId } = scope;

    // 1. Test action: workspace.create denial
    const wsRequestId = `ws-req-${crypto.randomUUID()}`;
    policy.denyActions.add('workspace.create');

    const denyWsRes = await postJson(
      '/api/workspaces',
      { name: 'Blocked Workspace', requestId: wsRequestId },
      ownerCookie,
    );
    expect(denyWsRes.status).toBe(402);
    expect(await denyWsRes.json()).toEqual({
      error: { code: 'payment_required', message: 'Policy denied workspace.create' },
    });

    // Verify workspace was not created in repository
    const accountRes = await request('/api/account', ownerCookie);
    const accountData = (await accountRes.json()) as { workspaces: Array<{ id: string }> };
    expect(accountData.workspaces.some((w) => w.id.includes(wsRequestId))).toBe(false);

    // Allow workspace creation to test idempotency retry behavior
    policy.denyActions.delete('workspace.create');
    const allowWsRes = await postJson(
      '/api/workspaces',
      { name: 'Allowed Workspace', requestId: wsRequestId },
      ownerCookie,
    );
    expect(allowWsRes.status).toBe(201);

    // Re-enable deny for workspace.create, then retry with the same requestId
    // Idempotent retry must succeed (201) without calling policy.authorize
    policy.denyActions.add('workspace.create');
    const idempotentWsRes = await postJson(
      '/api/workspaces',
      { name: 'Allowed Workspace', requestId: wsRequestId },
      ownerCookie,
    );
    expect(idempotentWsRes.status).toBe(201);
    policy.denyActions.delete('workspace.create');

    // 2. Test action: project.create denial
    policy.denyActions.add('project.create');
    const denyProjRes = await postJson(
      `/api/workspaces/${workspaceId}/projects`,
      { name: 'Blocked Project' },
      ownerCookie,
    );
    expect(denyProjRes.status).toBe(403);
    expect(await denyProjRes.json()).toEqual({
      error: { code: 'forbidden', message: 'Policy denied project.create' },
    });
    policy.denyActions.delete('project.create');

    // 3. Test action: invite.create denial
    policy.denyActions.add('invite.create');
    const denyInviteRes = await postJson(
      `/api/workspaces/${workspaceId}/invites`,
      { email: 'teammate@example.test', role: 'editor' },
      ownerCookie,
    );
    expect(denyInviteRes.status).toBe(403);
    expect(await denyInviteRes.json()).toEqual({
      error: { code: 'forbidden', message: 'Policy denied invite.create' },
    });
    policy.denyActions.delete('invite.create');

    // 4. Test action: member.add denial
    // Create invite first while invite.create is permitted
    const inviteRes = await postJson(
      `/api/workspaces/${workspaceId}/invites`,
      { email: 'teammate-policy@example.test', role: 'editor' },
      ownerCookie,
    );
    expect(inviteRes.status).toBe(200);
    const { token: inviteToken } = (await inviteRes.json()) as { token: string };

    // Deny member.add
    policy.denyActions.add('member.add');
    const denyMemberRes = await postJson('/api/auth/sign-up/email', {
      email: 'teammate-policy@example.test',
      password: 'password123',
      name: 'Teammate',
      inviteToken,
    });
    expect(denyMemberRes.status).toBe(402);
    expect(await denyMemberRes.json()).toEqual({
      error: { code: 'payment_required', message: 'Policy denied member.add' },
    });
    policy.denyActions.delete('member.add');

    // 5. Test action: file.upload denial
    policy.denyActions.add('file.upload');
    const pngBytes = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);
    const formData = new FormData();
    formData.append('file', new File([pngBytes], 'sample.png', { type: 'image/png' }));

    const denyUploadRes = await request(
      `/api/workspaces/${workspaceId}/projects/${projectId}/uploads`,
      ownerCookie,
      {
        method: 'POST',
        body: formData,
      },
    );
    expect(denyUploadRes.status).toBe(402);
    expect(await denyUploadRes.json()).toEqual({
      error: { code: 'payment_required', message: 'Policy denied file.upload' },
    });
    policy.denyActions.delete('file.upload');
  });

  it('translates database/custom quota errors via policy.mapError', async () => {
    // Setup an owner user using open mode
    policy.currentMode = 'open';
    const ownerRes = await postJson('/api/auth/sign-up/email', {
      email: 'map-error-owner@example.test',
      password: 'password123',
      name: 'Map Error Owner',
    });
    expect(ownerRes.status).toBe(200);
    const ownerCookie = ownerRes.headers.get('set-cookie')!;
    policy.currentMode = 'bootstrap-or-invite';

    const scope = await getAccountWorkspaceScope((path) => request(path, ownerCookie));

    // Enable custom error throwing in policy hook
    policy.throwCustomQuotaError = true;

    const res = await postJson(
      `/api/workspaces/${scope.workspaceId}/projects`,
      { name: 'Will Trigger Quota' },
      ownerCookie,
    );

    expect(res.status).toBe(402);
    expect(await res.json()).toEqual({
      error: {
        code: 'quota_exhausted',
        message: 'Database quota trigger violation',
      },
    });

    policy.throwCustomQuotaError = false;
  });
});

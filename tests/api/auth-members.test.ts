import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { createWorkerApp } from '../../src/worker/index';
import { createDb } from '../../src/core/adapters/db/d1/client';

const app = createWorkerApp(env);
import * as t from '../../src/core/adapters/db/d1/schema';
import { eq } from 'drizzle-orm';
import { expectInvariantsHold } from './helpers';

const db = createDb(env.DB);

describe('Phase 1: Auth, Workspace, Members, Invites & Security', () => {
  const bootstrapToken = env.BOOTSTRAP_TOKEN || 'test-bootstrap-token';

  it('rejects initial signup without bootstrap token', async () => {
    const res = await app.request(
      'http://localhost/api/auth/sign-up/email',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          email: 'first@example.com',
          password: 'password123',
          name: 'First User',
        }),
      },
      env,
    );

    expect(res.status).toBe(403);
    const data = (await res.json()) as { error: { code: string; message: string } };
    expect(data.error.code).toBe('invalid_bootstrap_token');
  });

  it('rejects initial signup with wrong bootstrap token', async () => {
    const res = await app.request(
      'http://localhost/api/auth/sign-up/email',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          email: 'first@example.com',
          password: 'password123',
          name: 'First User',
          bootstrapToken: 'wrong-token',
        }),
      },
      env,
    );

    expect(res.status).toBe(403);
    const data = (await res.json()) as { error: { code: string; message: string } };
    expect(data.error.code).toBe('invalid_bootstrap_token');
  });

  let ownerCookie = '';
  let ownerUserId = '';
  let workspaceId = '';
  const workspacePath = (path: string) => `/api/workspaces/${workspaceId}${path}`;

  it('succeeds initial signup with bootstrap token and creates workspace + project + welcome notepad', async () => {
    const res = await app.request(
      'http://localhost/api/auth/sign-up/email',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          email: 'owner@example.com',
          password: 'password123',
          name: 'Owner User',
          bootstrapToken,
        }),
      },
      env,
    );

    expect(res.status).toBe(200);
    const cookieHeader = res.headers.get('set-cookie');
    expect(cookieHeader).toBeTruthy();
    ownerCookie = cookieHeader!;

    // Verify security headers
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
    expect(res.headers.get('content-security-policy')).toContain("default-src 'self'");

    // Check database state
    const [workspace] = await db.select().from(t.workspaces);
    expect(workspace).toBeDefined();
    expect(workspace!.name).toBe('My Workspace');
    workspaceId = workspace!.id;

    const [member] = await db.select().from(t.members);
    expect(member).toBeDefined();
    expect(member!.role).toBe('owner');
    ownerUserId = member!.userId;

    const [project] = await db.select().from(t.projects);
    expect(project).toBeDefined();
    expect(project!.name).toBe('My first project');

    const [notepad] = await db.select().from(t.notepads);
    expect(notepad).toBeDefined();
    expect(notepad!.title).toBe('Welcome to Burrow');

    await expectInvariantsHold(env.DB);
  });

  it('rejects subsequent signup without invite token', async () => {
    const res = await app.request(
      'http://localhost/api/auth/sign-up/email',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          email: 'intruder@example.com',
          password: 'password123',
          name: 'Intruder',
        }),
      },
      env,
    );

    expect(res.status).toBe(403);
    const data = (await res.json()) as { error: { code: string; message: string } };
    expect(data.error.code).toBe('invite_required');
  });

  it('owner can generate and list invites', async () => {
    const createRes = await app.request(
      `http://localhost${workspacePath('/invites')}`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Cookie: ownerCookie,
        },
        body: JSON.stringify({
          email: 'editor@example.com',
          role: 'editor',
        }),
      },
      env,
    );

    expect(createRes.status).toBe(200);
    const inviteData = (await createRes.json()) as {
      id: string;
      token: string;
      email: string;
      role: string;
    };
    expect(inviteData.token).toBeDefined();
    expect(inviteData.email).toBe('editor@example.com');
    expect(inviteData.role).toBe('editor');

    const listRes = await app.request(
      `http://localhost${workspacePath('/invites')}`,
      {
        headers: { Cookie: ownerCookie },
      },
      env,
    );
    expect(listRes.status).toBe(200);
    const listData = (await listRes.json()) as Array<{ id: string }>;
    expect(listData.length).toBe(1);
    expect(listData[0]!.id).toBe(inviteData.id);
  });

  let editorCookie = '';
  let editorUserId = '';

  it('invited user can sign up with invite token and joins as editor', async () => {
    // Generate viewer invite first, then editor invite
    const inviteRes = await app.request(
      `http://localhost${workspacePath('/invites')}`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Cookie: ownerCookie,
        },
        body: JSON.stringify({
          email: 'teammate@example.com',
          role: 'editor',
        }),
      },
      env,
    );
    const { token } = (await inviteRes.json()) as { token: string };

    const signupRes = await app.request(
      'http://localhost/api/auth/sign-up/email',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          email: 'teammate@example.com',
          password: 'password123',
          name: 'Teammate Editor',
          inviteToken: token,
        }),
      },
      env,
    );

    expect(signupRes.status).toBe(200);
    editorCookie = signupRes.headers.get('set-cookie')!;

    const accountRes = await app.request(
      'http://localhost/api/account',
      {
        headers: { Cookie: editorCookie },
      },
      env,
    );
    expect(accountRes.status).toBe(200);
    const accountData = (await accountRes.json()) as { user: { id: string } };
    const contextRes = await app.request(
      `http://localhost${workspacePath('')}`,
      { headers: { Cookie: editorCookie } },
      env,
    );
    expect(contextRes.status).toBe(200);
    const contextData = (await contextRes.json()) as { workspace: { id: string }; role: string };
    expect(contextData.role).toBe('editor');
    expect(contextData.workspace.id).toBe(workspaceId);
    editorUserId = accountData.user.id;
  });

  it('re-using accepted invite token is rejected', async () => {
    // Look up the accepted invite
    const [invite] = await db
      .select()
      .from(t.invites)
      .where(eq(t.invites.email, 'teammate@example.com'));

    expect(invite).toBeDefined();
    expect(invite!.acceptedAt).not.toBeNull();

    const reuseRes = await app.request(
      'http://localhost/api/auth/sign-up/email',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          email: 'other@example.com',
          password: 'password123',
          name: 'Other',
          inviteToken: 'any-token',
        }),
      },
      env,
    );

    expect(reuseRes.status).toBe(403);
  });

  it('can preview invite info via public info endpoint', async () => {
    // Generate a fresh invite
    const createRes = await app.request(
      `http://localhost${workspacePath('/invites')}`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Cookie: ownerCookie,
        },
        body: JSON.stringify({
          email: 'preview@example.com',
          role: 'viewer',
        }),
      },
      env,
    );
    const { token } = (await createRes.json()) as { token: string };

    // Public lookup without any session cookie
    const infoRes = await app.request(
      `http://localhost/api/invites/info/${token}`,
      { method: 'GET' },
      env,
    );
    expect(infoRes.status).toBe(200);
    const infoData = (await infoRes.json()) as {
      valid: boolean;
      token: string;
      email: string;
      role: string;
      workspaceName: string;
    };
    expect(infoData.valid).toBe(true);
    expect(infoData.token).toBe(token);
    expect(infoData.email).toBe('preview@example.com');
    expect(infoData.role).toBe('viewer');
    expect(infoData.workspaceName).toBe('My Workspace');

    // Invalid token returns 404
    const notFoundRes = await app.request(
      'http://localhost/api/invites/info/nonexistent-token',
      { method: 'GET' },
      env,
    );
    expect(notFoundRes.status).toBe(404);
  });

  let viewerCookie = '';

  it('registers viewer user and tests role enforcement', async () => {
    const inviteRes = await app.request(
      `http://localhost${workspacePath('/invites')}`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Cookie: ownerCookie,
        },
        body: JSON.stringify({
          email: 'viewer@example.com',
          role: 'viewer',
        }),
      },
      env,
    );
    const { token } = (await inviteRes.json()) as { token: string };

    const signupRes = await app.request(
      'http://localhost/api/auth/sign-up/email',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          email: 'viewer@example.com',
          password: 'password123',
          name: 'Viewer User',
          inviteToken: token,
        }),
      },
      env,
    );
    expect(signupRes.status).toBe(200);
    viewerCookie = signupRes.headers.get('set-cookie')!;

    // Viewer hits mutating routes and gets 403
    const mutatingEndpoints = [
      { path: workspacePath('/invites'), method: 'POST', body: { email: 'x@y.com', role: 'viewer' } },
      { path: workspacePath(`/members/${editorUserId}`), method: 'PATCH', body: { role: 'viewer' } },
      { path: workspacePath(`/members/${editorUserId}`), method: 'DELETE', body: undefined },
    ];

    for (const ep of mutatingEndpoints) {
      const res = await app.request(
        `http://localhost${ep.path}`,
        {
          method: ep.method,
          headers: {
            'Content-Type': 'application/json',
            Cookie: viewerCookie,
          },
          body: ep.body ? JSON.stringify(ep.body) : undefined,
        },
        env,
      );
      expect(res.status).toBe(403);
      const err = (await res.json()) as { error: { code: string } };
      expect(err.error.code).toBe('forbidden');
    }
  });

  it('prevent removing or demoting the last owner', async () => {
    // Try to demote owner as owner
    const demoteRes = await app.request(
      `http://localhost${workspacePath(`/members/${ownerUserId}`)}`,
      {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
          Cookie: ownerCookie,
        },
        body: JSON.stringify({ role: 'editor' }),
      },
      env,
    );
    expect(demoteRes.status).toBe(400);
    const demoteErr = (await demoteRes.json()) as { error: { code: string } };
    expect(demoteErr.error.code).toBe('cannot_demote_last_owner');

    // Try to remove owner
    const removeRes = await app.request(
      `http://localhost${workspacePath(`/members/${ownerUserId}`)}`,
      {
        method: 'DELETE',
        headers: { Cookie: ownerCookie },
      },
      env,
    );
    expect(removeRes.status).toBe(400);
    const removeErr = (await removeRes.json()) as { error: { code: string } };
    expect(removeErr.error.code).toBe('cannot_remove_last_owner');
  });

  it('maps commit-time actor revocation to forbidden without changing the target role', async () => {
    const racingDb = new Proxy(env.DB, {
      get(target, property, receiver) {
        if (property === 'batch')
          return async (statements: D1PreparedStatement[]) => {
            await env.DB.prepare(
              "UPDATE members SET role = 'viewer' WHERE workspace_id = ? AND user_id = ?",
            )
              .bind(workspaceId, ownerUserId)
              .run();
            return target.batch(statements);
          };
        const value = Reflect.get(target, property, receiver);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
    try {
      const response = await createWorkerApp({ ...env, DB: racingDb }).request(
        `http://localhost${workspacePath(`/members/${editorUserId}`)}`,
        {
          method: 'PATCH',
          headers: { Cookie: ownerCookie, 'Content-Type': 'application/json' },
          body: JSON.stringify({ role: 'viewer' }),
        },
        env,
      );
      expect(response.status).toBe(403);
      expect(await response.json()).toMatchObject({ error: { code: 'forbidden' } });
      expect(
        await env.DB.prepare('SELECT role FROM members WHERE workspace_id = ? AND user_id = ?')
          .bind(workspaceId, editorUserId)
          .first(),
      ).toEqual({ role: 'editor' });
    } finally {
      await env.DB.prepare(
        "UPDATE members SET role = 'owner' WHERE workspace_id = ? AND user_id = ?",
      )
        .bind(workspaceId, ownerUserId)
        .run();
    }
  });

  it('returns not found when an owner targets a missing member', async () => {
    for (const method of ['PATCH', 'DELETE']) {
      const response = await app.request(
        `http://localhost${workspacePath(`/members/${crypto.randomUUID()}`)}`,
        {
          method,
          headers: { Cookie: ownerCookie, 'Content-Type': 'application/json' },
          ...(method === 'PATCH' ? { body: JSON.stringify({ role: 'viewer' }) } : {}),
        },
        env,
      );
      expect(response.status).toBe(404);
      expect(await response.json()).toMatchObject({ error: { code: 'not_found' } });
    }
  });

  it('rejects oversized request bodies with 413', async () => {
    const largeBody = 'x'.repeat(2_500_000);
    const res = await app.request(
      `http://localhost${workspacePath('/invites')}`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': '2500000',
          Cookie: ownerCookie,
        },
        body: largeBody,
      },
      env,
    );

    expect(res.status).toBe(413);
    const err = (await res.json()) as { error: { code: string } };
    expect(err.error.code).toBe('payload_too_large');
  });

  it('applies role changes immediately and revokes membership without destroying account sessions', async () => {
    const active = await app.request(
      `http://localhost${workspacePath('')}`,
      { headers: { Cookie: editorCookie } },
      env,
    );
    expect(active.status).toBe(200);
    const demoted = await app.request(
      `http://localhost${workspacePath(`/members/${editorUserId}`)}`,
      {
        method: 'PATCH',
        headers: { Cookie: ownerCookie, 'Content-Type': 'application/json' },
        body: JSON.stringify({ role: 'viewer' }),
      },
      env,
    );
    expect(demoted.status).toBe(200);
    const write = await app.request(
      `http://localhost${workspacePath('/projects')}`,
      {
        method: 'POST',
        headers: { Cookie: editorCookie, 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'No longer allowed' }),
      },
      env,
    );
    expect(write.status).toBe(403);

    const sessionsBefore = await db
      .select({ id: t.session.id })
      .from(t.session)
      .where(eq(t.session.userId, editorUserId));
    expect(sessionsBefore.length).toBeGreaterThan(0);
    const removed = await app.request(
      `http://localhost${workspacePath(`/members/${editorUserId}`)}`,
      {
        method: 'DELETE',
        headers: { Cookie: ownerCookie },
      },
      env,
    );
    expect(removed.status).toBe(200);
    const revoked = await app.request(
      'http://localhost/api/account',
      { headers: { Cookie: editorCookie } },
      env,
    );
    expect(revoked.status).toBe(200);
    const revokedWorkspace = await app.request(`http://localhost${workspacePath('')}`, { headers: { Cookie: editorCookie } }, env);
    expect(revokedWorkspace.status).toBe(404);
    const revokedProjects = await app.request(
      `http://localhost${workspacePath('/projects')}`,
      { headers: { Cookie: editorCookie } },
      env,
    );
    expect(revokedProjects.status).toBe(404);
    expect(
      await db
        .select({ id: t.session.id })
        .from(t.session)
        .where(eq(t.session.userId, editorUserId)),
    ).toEqual(sessionsBefore);

    // The account session remains usable for an invitation, even without a workspace.
    const invite = await app.request(
      `http://localhost${workspacePath('/invites')}`,
      {
        method: 'POST',
        headers: { Cookie: ownerCookie, 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: 'teammate@example.com', role: 'viewer' }),
      },
      env,
    );
    expect(invite.status).toBe(200);
    const { token } = (await invite.json()) as { token: string };
    const anonymous = await app.request(
      'http://localhost/api/invites/accept',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token }),
      },
      env,
    );
    expect(anonymous.status).toBe(401);
    const accept = () =>
      app.request(
        'http://localhost/api/invites/accept',
        {
          method: 'POST',
          headers: { Cookie: editorCookie, 'Content-Type': 'application/json' },
          body: JSON.stringify({ token }),
        },
        env,
      );
    expect((await accept()).status).toBe(200);
    expect((await accept()).status).toBe(400);
    const restored = await app.request(
      'http://localhost/api/account',
      { headers: { Cookie: editorCookie } },
      env,
    );
    expect(restored.status).toBe(200);
  });

  it('signs out an authenticated user and invalidates the account session', async () => {
    const accountBefore = await app.request(
      'http://localhost/api/account',
      {
        method: 'GET',
        headers: { Cookie: viewerCookie },
      },
      env,
    );
    expect(accountBefore.status).toBe(200);

    const signOutRes = await app.request(
      'http://localhost/api/auth/sign-out',
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Origin: 'http://localhost',
          Cookie: viewerCookie,
        },
      },
      env,
    );
    expect(signOutRes.status).toBe(200);

    const accountAfter = await app.request(
      'http://localhost/api/account',
      {
        method: 'GET',
        headers: { Cookie: viewerCookie },
      },
      env,
    );
    expect(accountAfter.status).toBe(401);
  });

  it('invariants hold after all tests', async () => {
    await expectInvariantsHold(env.DB);
  });
});

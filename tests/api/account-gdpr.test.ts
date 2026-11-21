import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { createD1Infrastructure } from '../../src/core/adapters/db/d1';
import { createDb } from '../../src/core/adapters/db/d1/client';
import { createCoreApp } from '../../src/core/app';
import { SelfHostedPolicy } from '../../src/core/policy';
import { DEFAULT_FEATURE_FLAGS, type FeatureFlagMap } from '../../src/shared/featureFlags';
import { createWorkerApp } from '../../src/worker';

function mergeCookieHeader(existingCookie: string, response: Response): string {
  const jar = new Map<string, string>();
  for (const part of existingCookie.split(';')) {
    const trimmed = part.trim();
    const eq = trimmed.indexOf('=');
    if (eq > 0) {
      jar.set(trimmed.slice(0, eq), trimmed.slice(eq + 1));
    }
  }
  const setCookies =
    typeof (response.headers as unknown as { getSetCookie?: () => string[] }).getSetCookie ===
    'function'
      ? (response.headers as unknown as { getSetCookie: () => string[] }).getSetCookie()
      : response.headers.get('set-cookie')
        ? [response.headers.get('set-cookie')!]
        : [];
  for (const raw of setCookies) {
    const firstPart = raw.split(';', 1)[0]?.trim() ?? '';
    const eq = firstPart.indexOf('=');
    if (eq > 0) {
      const name = firstPart.slice(0, eq);
      const val = firstPart.slice(eq + 1);
      if (!val || /max-age=0/i.test(raw)) {
        jar.delete(name);
      } else {
        jar.set(name, val);
      }
    }
  }
  return Array.from(jar.entries())
    .map(([k, v]) => `${k}=${v}`)
    .join('; ');
}

class AllDisabledFlagsPolicy extends SelfHostedPolicy {
  featureFlags(): Partial<FeatureFlagMap> {
    return { ...DEFAULT_FEATURE_FLAGS };
  }
}

describe('GDPR Account Export & Rectification API', () => {
  const bootstrapToken = env.BOOTSTRAP_TOKEN || 'test-bootstrap-token';

  it('GET /api/account/export works for viewers even when all workspace feature flags are disabled', async () => {
    const db = createDb(env.DB);
    const infra = createD1Infrastructure(db, {
      FILES: env.FILES,
      BETTER_AUTH_SECRET: env.BETTER_AUTH_SECRET,
      BETTER_AUTH_URL: env.BETTER_AUTH_URL,
      BOOTSTRAP_TOKEN: env.BOOTSTRAP_TOKEN,
    });
    const app = createCoreApp(infra, { policy: new AllDisabledFlagsPolicy() });

    const req = (path: string, cookie = '', init: RequestInit = {}) => {
      const headers = new Headers(init.headers);
      if (cookie) headers.set('Cookie', cookie);
      if (init.body !== undefined) headers.set('Content-Type', 'application/json');
      return app.request(`http://localhost${path}`, { ...init, headers }, env);
    };

    // Unauthenticated requests are rejected with 401
    expect((await req('/api/account/export')).status).toBe(401);

    // Owner signs up with bootstrapToken
    const ownerSignup = await req('/api/auth/sign-up/email', '', {
      method: 'POST',
      body: JSON.stringify({
        name: 'GDPR Export Owner',
        email: 'gdpr-export-owner@example.test',
        password: 'password123',
        bootstrapToken,
      }),
    });
    expect(ownerSignup.status).toBe(200);
    const ownerCookie = mergeCookieHeader('', ownerSignup);

    const ownerAccountRes = await req('/api/account', ownerCookie);
    expect(ownerAccountRes.status).toBe(200);
    const ownerAccount = (await ownerAccountRes.json()) as {
      user: { id: string };
      workspaces: Array<{ id: string }>;
    };
    const workspaceId = ownerAccount.workspaces[0]!.id;

    // Fetch starter project & notepad
    const projectsRes = await req(`/api/workspaces/${workspaceId}/projects`, ownerCookie);
    expect(projectsRes.status).toBe(200);
    const projects = (await projectsRes.json()) as Array<{ id: string }>;
    const projectId = projects[0]!.id;

    const notepadsRes = await req(
      `/api/workspaces/${workspaceId}/projects/${projectId}/notepads`,
      ownerCookie,
    );
    expect(notepadsRes.status).toBe(200);
    const notepads = (await notepadsRes.json()) as Array<{ id: string }>;
    const notepadId = notepads[0]!.id;

    // Create board & card
    const boardRes = await req(`/api/workspaces/${workspaceId}/projects/${projectId}/boards`, ownerCookie, {
      method: 'POST',
      body: JSON.stringify({ name: 'GDPR Board' }),
    });
    expect(boardRes.status).toBe(201);
    const boardId = ((await boardRes.json()) as { id: string }).id;

    const boardDetailRes = await req(
      `/api/workspaces/${workspaceId}/projects/${projectId}/boards/${boardId}`,
      ownerCookie,
    );
    expect(boardDetailRes.status).toBe(200);
    const columnId = ((await boardDetailRes.json()) as { columns: Array<{ id: string }> }).columns[0]!.id;

    const cardRes = await req(
      `/api/workspaces/${workspaceId}/projects/${projectId}/columns/${columnId}/cards`,
      ownerCookie,
      {
        method: 'POST',
        body: JSON.stringify({ title: 'GDPR Assigned Task' }),
      },
    );
    expect(cardRes.status).toBe(201);
    const cardId = ((await cardRes.json()) as { cardId: string }).cardId;

    // Invite second member initially as editor so they can author a comment
    const inviteRes = await req(`/api/workspaces/${workspaceId}/invites`, ownerCookie, {
      method: 'POST',
      body: JSON.stringify({ email: 'gdpr-viewer@example.test', role: 'editor' }),
    });
    expect(inviteRes.status).toBe(200);
    const inviteToken = ((await inviteRes.json()) as { token: string }).token;

    const memberSignup = await req('/api/auth/sign-up/email', '', {
      method: 'POST',
      body: JSON.stringify({
        name: 'GDPR Member',
        email: 'gdpr-viewer@example.test',
        password: 'password123',
        inviteToken,
      }),
    });
    expect(memberSignup.status).toBe(200);
    const memberCookie = mergeCookieHeader('', memberSignup);

    const memberAccountRes = await req('/api/account', memberCookie);
    expect(memberAccountRes.status).toBe(200);
    const memberUserId = ((await memberAccountRes.json()) as { user: { id: string } }).user.id;

    // Member posts a comment before being demoted to viewer
    const commentRes = await req(
      `/api/workspaces/${workspaceId}/projects/${projectId}/cards/${cardId}/comments`,
      memberCookie,
      {
        method: 'POST',
        body: JSON.stringify({ content: 'Personal comment for portability export' }),
      },
    );
    expect(commentRes.status).toBe(201);

    // Assign task to member & mention member in notepad to generate notifications
    const assignRes = await req(
      `/api/workspaces/${workspaceId}/projects/${projectId}/cards/${cardId}`,
      ownerCookie,
      {
        method: 'PATCH',
        body: JSON.stringify({ assigneeIds: [memberUserId] }),
      },
    );
    expect(assignRes.status).toBe(200);

    const mentionContent = JSON.stringify([
      {
        id: 'block-gdpr-1',
        type: 'paragraph',
        props: {},
        content: [
          { type: 'text', text: 'Ping ' },
          { type: 'mention', props: { kind: 'user', id: memberUserId, label: 'GDPR Member' } },
        ],
        children: [],
      },
    ]);
    const saveNotepadRes = await req(
      `/api/workspaces/${workspaceId}/projects/${projectId}/notepads/${notepadId}/content`,
      ownerCookie,
      {
        method: 'PUT',
        body: JSON.stringify({ content: mentionContent, baseVersion: 1 }),
      },
    );
    expect(saveNotepadRes.status).toBe(200);

    // Demote member to viewer and verify workspaceExport feature flag is off
    const demoteRes = await req(
      `/api/workspaces/${workspaceId}/members/${memberUserId}`,
      ownerCookie,
      {
        method: 'PATCH',
        body: JSON.stringify({ role: 'viewer' }),
      },
    );
    expect(demoteRes.status).toBe(200);

    // Workspace ZIP export route is disabled when workspaceExport is false,
    // yet personal GDPR export MUST remain accessible for viewer
    const blockedWsExportRes = await req(`/api/workspaces/${workspaceId}/export`, memberCookie);
    expect(blockedWsExportRes.status).toBe(404);

    const exportRes = await req('/api/account/export', memberCookie);
    expect(exportRes.status).toBe(200);
    expect(exportRes.headers.get('cache-control')).toBe('private, no-store');
    expect(exportRes.headers.get('content-disposition')).toBeNull();

    const exportBody = (await exportRes.json()) as {
      schemaVersion: string;
      exportedAt: number;
      scope: { type: string; workspaceId?: string; workspaceName?: string | null };
      user: { id: string; email: string; name: string };
      workspaces: Array<{ id: string; name: string; role: string }>;
      assignedTasks: Array<{ id: string; title: string; workspaceId: string; workspaceName: string }>;
      comments: Array<{
        content: string;
        cardId: string | null;
        workspaceId: string | null;
        workspaceName: string | null;
        projectId: string | null;
        formerWorkspace: boolean;
      }>;
      notifications: Array<{ workspaceId: string; workspaceName: string; type: string }>;
    };

    expect(exportBody.schemaVersion).toBe('burrow-personal-export-v1');
    expect(typeof exportBody.exportedAt).toBe('number');
    expect(exportBody.scope).toEqual({ type: 'all-workspaces' });
    expect(exportBody.user).toMatchObject({
      id: memberUserId,
      email: 'gdpr-viewer@example.test',
      name: 'GDPR Member',
    });
    expect(exportBody.workspaces).toEqual(
      expect.arrayContaining([expect.objectContaining({ id: workspaceId, role: 'viewer' })]),
    );
    const wsName = exportBody.workspaces.find((w) => w.id === workspaceId)!.name;
    expect(exportBody.assignedTasks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: cardId,
          title: 'GDPR Assigned Task',
          workspaceId,
          workspaceName: wsName,
        }),
      ]),
    );
    expect(exportBody.comments).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          content: 'Personal comment for portability export',
          cardId,
          workspaceId,
          workspaceName: wsName,
          formerWorkspace: false,
        }),
      ]),
    );
    expect(exportBody.notifications.length).toBeGreaterThanOrEqual(1);
    expect(exportBody.notifications[0]?.workspaceName).toBe(wsName);

    // ?download=1 sets Content-Disposition attachment header
    const downloadRes = await req('/api/account/export?download=1', memberCookie);
    expect(downloadRes.status).toBe(200);
    expect(downloadRes.headers.get('cache-control')).toBe('private, no-store');
    expect(downloadRes.headers.get('content-disposition')).toMatch(
      /^attachment; filename="burrow-personal-data-\d{4}-\d{2}-\d{2}\.json"$/,
    );

    // Single-workspace filter (?workspaceId=...) scopes export and rejects non-member workspace IDs
    const scopedRes = await req(
      `/api/account/export?download=1&workspaceId=${encodeURIComponent(workspaceId)}`,
      memberCookie,
    );
    expect(scopedRes.status).toBe(200);
    expect(scopedRes.headers.get('content-disposition')).toMatch(
      /^attachment; filename="burrow-personal-data-[a-z0-9-]+-\d{4}-\d{2}-\d{2}\.json"$/,
    );
    const scopedBody = (await scopedRes.json()) as typeof exportBody;
    expect(scopedBody.scope).toEqual({
      type: 'workspace',
      workspaceId,
      workspaceName: wsName,
    });
    expect(scopedBody.workspaces).toHaveLength(1);
    expect(scopedBody.comments).toHaveLength(1);

    const unknownWsRes = await req('/api/account/export?workspaceId=not-a-member-ws', memberCookie);
    expect(unknownWsRes.status).toBe(404);

    // After removal from workspace, authored comments retain text for GDPR Art. 15
    // while internal workspace/project/card identifiers are redacted
    const removeMemberRes = await req(
      `/api/workspaces/${workspaceId}/members/${memberUserId}`,
      ownerCookie,
      { method: 'DELETE' },
    );
    expect(removeMemberRes.status).toBe(200);

    expect(
      (await req(`/api/account/export?workspaceId=${encodeURIComponent(workspaceId)}`, memberCookie))
        .status,
    ).toBe(404);

    const postRemovalRes = await req('/api/account/export', memberCookie);
    expect(postRemovalRes.status).toBe(200);
    const postRemovalBody = (await postRemovalRes.json()) as typeof exportBody;
    expect(postRemovalBody.workspaces).toEqual([]);
    expect(postRemovalBody.assignedTasks).toEqual([]);
    expect(postRemovalBody.notifications).toEqual([]);
    expect(postRemovalBody.comments).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          content: 'Personal comment for portability export',
          cardId: null,
          workspaceId: null,
          workspaceName: null,
          projectId: null,
          formerWorkspace: true,
        }),
      ]),
    );
  });

  it('POST /api/auth/update-user updates profile name across DB, /api/account, and /api/account/export', async () => {
    const app = createWorkerApp(env);
    let cookie = '';

    const req = (path: string, init: RequestInit = {}, includeOrigin = false) => {
      const headers = new Headers(init.headers);
      if (cookie) headers.set('Cookie', cookie);
      if (includeOrigin) headers.set('Origin', 'http://localhost');
      if (init.body !== undefined) headers.set('Content-Type', 'application/json');
      return app.request(`http://localhost${path}`, { ...init, headers }, env);
    };

    // Reuse an already bootstrapped instance: invite or create a fresh user
    // First ensure an owner exists or sign up if bootstrap is still unused
    const configRes = await req('/api/auth/config');
    expect(configRes.status).toBe(200);

    // Use existing gdpr-export-owner@example.test or create a new user if fresh DB
    let userId: string;
    const signupAttempt = await req('/api/auth/sign-up/email', {
      method: 'POST',
      body: JSON.stringify({
        name: 'Initial Name',
        email: 'gdpr-rectify@example.test',
        password: 'password123',
        bootstrapToken,
      }),
    });

    if (signupAttempt.status === 200) {
      cookie = mergeCookieHeader(cookie, signupAttempt);
      const acct = (await (await req('/api/account')).json()) as { user: { id: string } };
      userId = acct.user.id;
    } else {
      // Instance already bootstrapped by previous test: sign in as owner to issue invite
      const ownerSignIn = await req(
        '/api/auth/sign-in/email',
        {
          method: 'POST',
          body: JSON.stringify({
            email: 'gdpr-export-owner@example.test',
            password: 'password123',
          }),
        },
        true,
      );
      expect(ownerSignIn.status).toBe(200);
      cookie = mergeCookieHeader('', ownerSignIn);
      const ownerAcct = (await (await req('/api/account')).json()) as {
        workspaces: Array<{ id: string }>;
      };
      const wsId = ownerAcct.workspaces[0]!.id;

      const invRes = await req(`/api/workspaces/${wsId}/invites`, {
        method: 'POST',
        body: JSON.stringify({ email: 'gdpr-rectify@example.test', role: 'editor' }),
      });
      expect(invRes.status).toBe(200);
      const invToken = ((await invRes.json()) as { token: string }).token;

      cookie = '';
      const invitedSignup = await req('/api/auth/sign-up/email', {
        method: 'POST',
        body: JSON.stringify({
          name: 'Initial Name',
          email: 'gdpr-rectify@example.test',
          password: 'password123',
          inviteToken: invToken,
        }),
      });
      expect(invitedSignup.status).toBe(200);
      cookie = mergeCookieHeader('', invitedSignup);
      const acct = (await (await req('/api/account')).json()) as { user: { id: string } };
      userId = acct.user.id;
    }

    // Rectify display name via Better Auth endpoint
    const updateRes = await req(
      '/api/auth/update-user',
      {
        method: 'POST',
        body: JSON.stringify({ name: 'Updated Name' }),
      },
      true,
    );
    expect(updateRes.status).toBe(200);
    cookie = mergeCookieHeader(cookie, updateRes);

    // Verify persisted in D1 user table
    const dbRow = await env.DB.prepare('SELECT name FROM user WHERE id = ?')
      .bind(userId)
      .first<{ name: string }>();
    expect(dbRow?.name).toBe('Updated Name');

    // Verify GET /api/account reflects updated name with refreshed session cookie
    const refreshedAccountRes = await req('/api/account');
    expect(refreshedAccountRes.status).toBe(200);
    const refreshedAccount = (await refreshedAccountRes.json()) as {
      user: { id: string; name: string; email: string };
      workspaces: Array<{ id: string }>;
    };
    expect(refreshedAccount.user.name).toBe('Updated Name');
    expect(refreshedAccount.workspaces.length).toBeGreaterThanOrEqual(1);

    // Author a workspace task/comment under updated user and verify personal export reflects updated profile
    const wsId = refreshedAccount.workspaces[0]!.id;
    const projRes = await req(`/api/workspaces/${wsId}/projects`);
    const projId = ((await projRes.json()) as Array<{ id: string }>)[0]!.id;

    const boardRes = await req(`/api/workspaces/${wsId}/projects/${projId}/boards`, {
      method: 'POST',
      body: JSON.stringify({ name: 'Rectification Board' }),
    });
    expect(boardRes.status).toBe(201);
    const boardId = ((await boardRes.json()) as { id: string }).id;

    const boardDetail = (await (
      await req(`/api/workspaces/${wsId}/projects/${projId}/boards/${boardId}`)
    ).json()) as { columns: Array<{ id: string }> };
    const colId = boardDetail.columns[0]!.id;

    const cardRes = await req(`/api/workspaces/${wsId}/projects/${projId}/columns/${colId}/cards`, {
      method: 'POST',
      body: JSON.stringify({ title: 'Updated User Task' }),
    });
    expect(cardRes.status).toBe(201);
    const cardId = ((await cardRes.json()) as { cardId: string }).cardId;

    const commentRes = await req(
      `/api/workspaces/${wsId}/projects/${projId}/cards/${cardId}/comments`,
      {
        method: 'POST',
        body: JSON.stringify({ content: 'Authored after name update' }),
      },
    );
    expect(commentRes.status).toBe(201);

    const personalExportRes = await req('/api/account/export');
    expect(personalExportRes.status).toBe(200);
    const exportData = (await personalExportRes.json()) as {
      schemaVersion: string;
      user: { id: string; name: string; email: string };
      comments: Array<{ content: string; cardId: string }>;
    };
    expect(exportData.schemaVersion).toBe('burrow-personal-export-v1');
    expect(exportData.user).toMatchObject({
      id: userId,
      name: 'Updated Name',
      email: 'gdpr-rectify@example.test',
    });
    expect(exportData.comments).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          content: 'Authored after name update',
          cardId,
        }),
      ]),
    );
  });
});

import { env } from 'cloudflare:test';
import { expect, it } from 'vitest';
import { createWorkerApp } from '../../src/worker';

const app = createWorkerApp(env);

it('scopes workspace context, members, invites, role changes, removal and leave by workspace membership', async () => {
  const request = (path: string, cookie = '', init: RequestInit = {}) => {
    const headers = new Headers(init.headers);
    if (cookie) headers.set('Cookie', cookie);
    if (init.body !== undefined) headers.set('Content-Type', 'application/json');
    return app.request(`http://localhost${path}`, { ...init, headers }, env);
  };
  const post = (path: string, body: unknown, cookie = '') =>
    request(path, cookie, { method: 'POST', body: JSON.stringify(body) });
  const newWorkspaceBody = (name: string) => ({ name, requestId: crypto.randomUUID() });
  const enroll = async (path: string, cookie: string, email: string, role: 'editor' | 'viewer') => {
    const invitation = await post(path, { email, role }, cookie);
    expect(invitation.status).toBe(200);
    const { token } = (await invitation.json()) as { token: string };
    const signup = await post('/api/auth/sign-up/email', {
      name: role === 'editor' ? 'Workspace editor' : 'Workspace viewer',
      email,
      password: 'password123',
      inviteToken: token,
    });
    expect(signup.status).toBe(200);
    return signup.headers.get('set-cookie')!;
  };
  const account = async (cookie: string) =>
    (await (await request('/api/account', cookie)).json()) as {
      user: { id: string; email: string };
      workspaces: Array<{ id: string; role: string }>;
    };

  const ownerSignup = await post('/api/auth/sign-up/email', {
    name: 'Workspace manager',
    email: 'workspace-manager@example.test',
    password: 'password123',
    bootstrapToken: env.BOOTSTRAP_TOKEN || 'test-bootstrap-token',
  });
  expect(ownerSignup.status).toBe(200);
  const ownerCookie = ownerSignup.headers.get('set-cookie')!;
  const initialAccount = await account(ownerCookie);
  const workspaceA = initialAccount.workspaces[0]!.id;

  const secondWorkspaceResponse = await post(
    '/api/workspaces',
    newWorkspaceBody('Second managed workspace'),
    ownerCookie,
  );
  expect(secondWorkspaceResponse.status).toBe(201);
  const secondWorkspace = (await secondWorkspaceResponse.json()) as {
    workspace: { id: string };
  };
  const workspaceB = secondWorkspace.workspace.id;

  const viewerCookie = await enroll(
    `/api/workspaces/${workspaceA}/invites`,
    ownerCookie,
    'workspace-a-viewer@example.test',
    'viewer',
  );
  const editorCookie = await enroll(
    `/api/workspaces/${workspaceB}/invites`,
    ownerCookie,
    'workspace-b-editor@example.test',
    'editor',
  );
  const viewer = await account(viewerCookie);
  const editor = await account(editorCookie);
  const owner = await account(ownerCookie);
  expect(viewer.workspaces.map(({ id }) => id)).toEqual([workspaceA]);
  expect(viewer.workspaces[0]?.role).toBe('viewer');
  expect(editor.workspaces.map(({ id }) => id)).toEqual([workspaceB]);
  expect(owner.workspaces.map(({ id }) => id)).toEqual(expect.arrayContaining([workspaceA, workspaceB]));

  expect((await request(`/api/workspaces/${workspaceA}`, editorCookie)).status).toBe(404);
  expect((await request(`/api/workspaces/${workspaceA}`, viewerCookie)).status).toBe(200);
  const viewerContext = (await (
    await request(`/api/workspaces/${workspaceA}`, viewerCookie)
  ).json()) as { workspace: { id: string }; role: string };
  expect(viewerContext).toMatchObject({ workspace: { id: workspaceA }, role: 'viewer' });
  const ownerContext = (await (
    await request(`/api/workspaces/${workspaceB}`, ownerCookie)
  ).json()) as { workspace: { id: string }; role: string };
  expect(ownerContext).toMatchObject({ workspace: { id: workspaceB }, role: 'owner' });
  expect((await request(`/api/workspaces/missing`, ownerCookie)).status).toBe(404);

  const rename = await request(`/api/workspaces/${workspaceB}`, ownerCookie, {
    method: 'PATCH',
    body: JSON.stringify({ name: 'Renamed workspace' }),
  });
  expect(rename.status).toBe(200);
  expect(await rename.json()).toMatchObject({ ok: true, workspaceId: workspaceB });
  for (const cookie of [viewerCookie, editorCookie]) {
    const denied = await request(`/api/workspaces/${cookie === viewerCookie ? workspaceA : workspaceB}`, cookie, {
      method: 'PATCH',
      body: JSON.stringify({ name: 'Not allowed' }),
    });
    expect(denied.status).toBe(403);
  }

  const membersA = `/api/workspaces/${workspaceA}/members`;
  const membersB = `/api/workspaces/${workspaceB}/members`;
  const listA = await request(membersA, viewerCookie);
  expect(listA.status).toBe(200);
  const listABody = (await listA.json()) as Array<{ userId: string }>;
  expect(listABody.map(({ userId }) => userId)).toEqual(
    expect.arrayContaining([owner.user.id, viewer.user.id]),
  );
  expect(listABody.map(({ userId }) => userId)).not.toContain(editor.user.id);
  const listB = await request(membersB, editorCookie);
  expect(listB.status).toBe(200);
  const listBBody = (await listB.json()) as Array<{ userId: string }>;
  expect(listBBody.map(({ userId }) => userId)).toEqual(
    expect.arrayContaining([owner.user.id, editor.user.id]),
  );
  expect(listBBody.map(({ userId }) => userId)).not.toContain(viewer.user.id);

  const ownerOnlyInvite = await post(`${membersA.replace('/members', '/invites')}`, {
    email: 'scoped-pending-a@example.test',
    role: 'viewer',
  }, ownerCookie);
  expect(ownerOnlyInvite.status).toBe(200);
  const pendingA = (await ownerOnlyInvite.json()) as { id: string };
  const pendingBResponse = await post(`/api/workspaces/${workspaceB}/invites`, {
    email: 'scoped-pending-b@example.test',
    role: 'editor',
  }, ownerCookie);
  expect(pendingBResponse.status).toBe(200);
  const pendingB = (await pendingBResponse.json()) as { id: string };
  expect((await post(`/api/workspaces/${workspaceA}/invites`, {
    email: 'viewer-cannot-invite@example.test',
    role: 'viewer',
  }, viewerCookie)).status).toBe(403);
  expect((await post(`/api/workspaces/${workspaceB}/invites`, {
    email: 'editor-cannot-invite@example.test',
    role: 'viewer',
  }, editorCookie)).status).toBe(403);

  const invitesAResponse = await request(`/api/workspaces/${workspaceA}/invites`, ownerCookie);
  const invitesBResponse = await request(`/api/workspaces/${workspaceB}/invites`, ownerCookie);
  expect(invitesAResponse.status).toBe(200);
  expect(invitesBResponse.status).toBe(200);
  const inviteIdsA = ((await invitesAResponse.json()) as Array<{ id: string }>).map(({ id }) => id);
  const inviteIdsB = ((await invitesBResponse.json()) as Array<{ id: string }>).map(({ id }) => id);
  expect(inviteIdsA).toContain(pendingA.id);
  expect(inviteIdsA).not.toContain(pendingB.id);
  expect(inviteIdsB).toContain(pendingB.id);
  expect(inviteIdsB).not.toContain(pendingA.id);

  const crossWorkspaceInvite = await post(`/api/workspaces/${workspaceB}/invites`, {
    email: viewer.user.email,
    role: 'editor',
  }, ownerCookie);
  expect(crossWorkspaceInvite.status).toBe(200);
  const crossInviteToken = (await crossWorkspaceInvite.json() as { token: string }).token;
  const acceptExistingAccount = await post('/api/invites/accept', { token: crossInviteToken }, viewerCookie);
  expect(acceptExistingAccount.status).toBe(200);
  expect(await acceptExistingAccount.json()).toMatchObject({ workspaceId: workspaceB, role: 'editor' });
  expect((await account(viewerCookie)).workspaces.map(({ id }) => id)).toEqual(
    expect.arrayContaining([workspaceA, workspaceB]),
  );
  const membersAfterCrossInvite = await request(membersA, ownerCookie);
  const unchangedRole = ((await membersAfterCrossInvite.json()) as Array<{
    userId: string;
    role: string;
  }>).find(({ userId }) => userId === viewer.user.id);
  expect(unchangedRole?.role).toBe('viewer');

  const deleteForeignInvite = await request(
    `/api/workspaces/${workspaceA}/invites/${pendingB.id}`,
    ownerCookie,
    { method: 'DELETE' },
  );
  expect(deleteForeignInvite.status).toBe(200);
  const inviteBStillPending = await request(`/api/workspaces/${workspaceB}/invites`, ownerCookie);
  expect(((await inviteBStillPending.json()) as Array<{ id: string }>).map(({ id }) => id)).toContain(
    pendingB.id,
  );
  const deleteInvite = await request(
    `/api/workspaces/${workspaceA}/invites/${pendingA.id}`,
    ownerCookie,
    { method: 'DELETE' },
  );
  expect(deleteInvite.status).toBe(200);

  const forbiddenRoleChange = await request(`${membersA}/${viewer.user.id}`, viewerCookie, {
    method: 'PATCH',
    body: JSON.stringify({ role: 'editor' }),
  });
  expect(forbiddenRoleChange.status).toBe(403);
  const promoteViewer = await request(`${membersA}/${viewer.user.id}`, ownerCookie, {
    method: 'PATCH',
    body: JSON.stringify({ role: 'owner' }),
  });
  expect(promoteViewer.status).toBe(200);

  const demoteCrossWorkspace = await request(`${membersB}/${viewer.user.id}`, ownerCookie, {
    method: 'PATCH',
    body: JSON.stringify({ role: 'viewer' }),
  });
  expect(demoteCrossWorkspace.status).toBe(200);
  const splitRoles = await account(viewerCookie);
  expect(splitRoles.workspaces).toEqual(expect.arrayContaining([
    expect.objectContaining({ id: workspaceA, role: 'owner' }),
    expect.objectContaining({ id: workspaceB, role: 'viewer' }),
  ]));
  const ownerWrite = await post(`/api/workspaces/${workspaceA}/projects`, {
    name: 'Owner role is workspace-local',
  }, viewerCookie);
  expect(ownerWrite.status).toBe(201);
  const viewerWrite = await post(`/api/workspaces/${workspaceB}/projects`, {
    name: 'Viewer role is workspace-local',
  }, viewerCookie);
  expect(viewerWrite.status).toBe(403);

  const lastOwnerLeave = await post(`/api/workspaces/${workspaceB}/leave`, {}, ownerCookie);
  expect(lastOwnerLeave.status).toBe(400);
  const ownerStillMember = await request(`/api/workspaces/${workspaceB}`, ownerCookie);
  expect(ownerStillMember.status).toBe(200);

  const leaveA = await post(`/api/workspaces/${workspaceA}/leave`, {}, ownerCookie);
  expect(leaveA.status).toBe(200);
  expect(await leaveA.json()).toMatchObject({ ok: true, workspaceId: workspaceA });
  const ownerAfterLeave = await account(ownerCookie);
  expect(ownerAfterLeave.workspaces.map(({ id }) => id)).toEqual([workspaceB]);
  expect((await request(`/api/workspaces/${workspaceA}`, ownerCookie)).status).toBe(404);
  expect((await request(`/api/workspaces/${workspaceA}`, viewerCookie)).status).toBe(200);

  const removeEditor = await request(`${membersB}/${editor.user.id}`, ownerCookie, {
    method: 'DELETE',
  });
  expect(removeEditor.status).toBe(200);
  expect((await request(`/api/workspaces/${workspaceB}`, editorCookie)).status).toBe(404);
  expect((await request('/api/account', editorCookie)).status).toBe(200);
  expect((await account(editorCookie)).workspaces).toEqual([]);
});

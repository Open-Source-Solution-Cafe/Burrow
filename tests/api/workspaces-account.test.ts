import { env } from 'cloudflare:test';
import { expect, it } from 'vitest';
import { createD1Infrastructure } from '../../src/core/adapters/db/d1';
import { createDb } from '../../src/core/adapters/db/d1/client';
import { createWorkerApp } from '../../src/worker';

const app = createWorkerApp(env);
const db = createDb(env.DB);

it('lists account memberships and lets a zero-membership account create a workspace with starter data', async () => {
  const request = (path: string, cookie = '', init: RequestInit = {}) => {
    const headers = new Headers(init.headers);
    if (cookie) headers.set('Cookie', cookie);
    if (init.body !== undefined) headers.set('Content-Type', 'application/json');
    return app.request(`http://localhost${path}`, { ...init, headers }, env);
  };
  const post = (path: string, body: unknown, cookie = '') =>
    request(path, cookie, { method: 'POST', body: JSON.stringify(body) });
  const newWorkspaceBody = (name: string) => ({ name, requestId: crypto.randomUUID() });

  const firstAccount = await post('/api/auth/sign-up/email', {
    name: 'Workspace account owner',
    email: 'workspace-account-owner@example.test',
    password: 'password123',
    bootstrapToken: env.BOOTSTRAP_TOKEN || 'test-bootstrap-token',
  });
  expect(firstAccount.status).toBe(200);
  const ownerCookie = firstAccount.headers.get('set-cookie')!;

  const infrastructure = createD1Infrastructure(db, env);
  const zeroMembershipSignup = await infrastructure.auth.handler(
    new Request('http://localhost/api/auth/sign-up/email', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: 'Zero membership account',
        email: 'zero-membership@example.test',
        password: 'password123',
      }),
    }),
  );
  expect(zeroMembershipSignup.status).toBe(200);
  const zeroMembershipCookie = zeroMembershipSignup.headers.get('set-cookie')!;
  const session = (await (
    await request('/api/auth/get-session', zeroMembershipCookie)
  ).json()) as { user: { id: string } };

  expect((await request('/api/account')).status).toBe(401);
  expect((await request('/api/workspaces')).status).toBe(401);

  const emptyAccount = await request('/api/account', zeroMembershipCookie);
  expect(emptyAccount.status).toBe(200);
  expect(await emptyAccount.json()).toMatchObject({
    user: {
      id: session.user.id,
      name: 'Zero membership account',
      email: 'zero-membership@example.test',
      image: null,
    },
    workspaces: [],
  });
  const emptyWorkspaceList = await request('/api/workspaces', zeroMembershipCookie);
  expect(emptyWorkspaceList.status).toBe(200);
  expect(await emptyWorkspaceList.json()).toEqual([]);

  const workspaceResponse = await post(
    '/api/workspaces',
    newWorkspaceBody('Personal workspace'),
    zeroMembershipCookie,
  );
  expect(workspaceResponse.status).toBe(201);
  const created = (await workspaceResponse.json()) as {
    workspace: { id: string; name: string; createdBy: string; createdAt: number };
    project: { id: string; workspaceId: string; name: string };
  };
  expect(created.workspace).toMatchObject({
    name: 'Personal workspace',
    createdBy: session.user.id,
  });
  expect(created.workspace.id).toBeTruthy();
  expect(created.workspace.createdAt).toEqual(expect.any(Number));
  expect(created.project).toMatchObject({ workspaceId: created.workspace.id });
  expect(created.project.id).toBeTruthy();

  const [member] = await env.DB.prepare(
    'SELECT role FROM members WHERE workspace_id = ? AND user_id = ?',
  )
    .bind(created.workspace.id, session.user.id)
    .all<{ role: string }>()
    .then((result) => result.results);
  expect(member?.role).toBe('owner');
  const [starterProject] = await env.DB.prepare(
    'SELECT id, workspace_id FROM projects WHERE id = ?',
  )
    .bind(created.project.id)
    .all<{ id: string; workspace_id: string }>()
    .then((result) => result.results);
  expect(starterProject).toMatchObject({ id: created.project.id, workspace_id: created.workspace.id });
  const starterNotepads = await env.DB.prepare(
    'SELECT id FROM notepads WHERE project_id = ?',
  )
    .bind(created.project.id)
    .all<{ id: string }>();
  expect(starterNotepads.results).toHaveLength(1);

  const accountAfterCreation = await request('/api/account', zeroMembershipCookie);
  expect(accountAfterCreation.status).toBe(200);
  expect(await accountAfterCreation.json()).toMatchObject({
    workspaces: [{ id: created.workspace.id, name: 'Personal workspace', role: 'owner' }],
  });

  const bootstrapAccount = (await (
    await request('/api/account', ownerCookie)
  ).json()) as { workspaces: Array<{ id: string; role: string }> };
  const bootstrapWorkspaceId = bootstrapAccount.workspaces[0]!.id;
  const ownerAccount = await request('/api/account', ownerCookie);
  expect(ownerAccount.status).toBe(200);
  expect(await ownerAccount.json()).toMatchObject({
    workspaces: [{ id: bootstrapWorkspaceId, role: 'owner' }],
  });
  expect(await (await request('/api/workspaces', ownerCookie)).json()).toMatchObject([
    { id: bootstrapWorkspaceId, role: 'owner' },
  ]);

  const secondWorkspaceBody = newWorkspaceBody('Second workspace');
  const anotherWorkspace = await post('/api/workspaces', secondWorkspaceBody, ownerCookie);
  expect(anotherWorkspace.status).toBe(201);
  const second = (await anotherWorkspace.json()) as { workspace: { id: string } };
  const replay = await post('/api/workspaces', secondWorkspaceBody, ownerCookie);
  expect(replay.status).toBe(201);
  expect(await replay.json()).toMatchObject({ workspace: { id: second.workspace.id } });
  const ownerMemberships = (await (
    await request('/api/account', ownerCookie)
  ).json()) as { workspaces: Array<{ id: string }> };
  expect(ownerMemberships.workspaces.map(({ id }) => id)).toEqual(
    expect.arrayContaining([bootstrapWorkspaceId, second.workspace.id]),
  );

  const count = async (table: 'workspaces' | 'members' | 'projects' | 'notepads') => {
    const row = await env.DB.prepare(`SELECT count(*) AS count FROM ${table}`).first<{
      count: number;
    }>();
    return row!.count;
  };
  const before = await Promise.all(
    (['workspaces', 'members', 'projects', 'notepads'] as const).map(count),
  );
  await env.DB.prepare(
    "CREATE TRIGGER fail_starter_project BEFORE INSERT ON projects BEGIN SELECT RAISE(ABORT, 'forced_starter_project_failure'); END",
  ).run();
  try {
    const failedCreate = await post(
      '/api/workspaces',
      newWorkspaceBody('Must roll back'),
      zeroMembershipCookie,
    );
    expect(failedCreate.status).not.toBe(201);
    const after = await Promise.all(
      (['workspaces', 'members', 'projects', 'notepads'] as const).map(count),
    );
    expect(after).toEqual(before);
  } finally {
    await env.DB.prepare('DROP TRIGGER IF EXISTS fail_starter_project').run();
  }
});

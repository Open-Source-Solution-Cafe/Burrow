import { Hono } from 'hono';
import { expect, it, vi } from 'vitest';
import type { Env } from '../app';
import type { IMemberRepository, IWorkspaceRepository } from '../infrastructure/types';
import { InviteService } from '../services/invites';
import { MemberService } from '../services/members';
import { createWorkspaceRoutes } from './workspaces';

function createApp(role: 'owner' | 'viewer' = 'owner', initialCreated = false) {
  const workspace = {
    id: 'workspace-request-123',
    name: 'Personal workspace',
    createdBy: 'account-1',
    createdAt: 100,
  };
  const project = {
    id: 'workspace-request-123-project',
    workspaceId: workspace.id,
    name: 'My first project',
    icon: null,
    color: null,
    position: 'a0',
    createdAt: 100,
    updatedAt: 100,
  };
  let exists = initialCreated;
  const workspaces = {
    listByUser: vi.fn().mockResolvedValue([]),
    findById: vi.fn().mockImplementation(async (id: string) => (exists && id === workspace.id ? workspace : null)),
    create: vi.fn().mockImplementation(async () => {
      exists = true;
      return workspace;
    }),
    rename: vi.fn().mockResolvedValue(true),
  } as unknown as IWorkspaceRepository;
  const members = {
    findByUserId: vi.fn().mockImplementation(async (wid: string, userId: string) =>
      wid === workspace.id && userId === 'account-1'
        ? { workspaceId: wid, userId, role, joinedAt: 100 }
        : null,
    ),
    listByWorkspace: vi.fn().mockResolvedValue([]),
    updateRole: vi.fn().mockResolvedValue(undefined),
    remove: vi.fn().mockResolvedValue(undefined),
  } as unknown as IMemberRepository;
  const invites = {
    listPending: vi.fn().mockResolvedValue([]),
    findByTokenHash: vi.fn().mockResolvedValue(null),
    create: vi.fn(),
    acceptForUser: vi.fn(),
    delete: vi.fn(),
  };
  const email = { send: vi.fn().mockResolvedValue(undefined) };
  const routes = createWorkspaceRoutes({
    workspaces,
    members,
    memberService: new MemberService({ members }),
    invites: new InviteService({ invites, members, workspaces }),
    email,
  });
  const app = new Hono<Env>();
  app.use('*', async (c, next) => {
    if (c.req.header('X-Account') === 'account-1') {
      c.set('identity', {
        userId: 'account-1',
        name: 'Account One',
        email: 'one@example.test',
        image: null,
      });
    }
    await next();
  });
  app.route('/api/workspaces', routes);
  return { app, workspaces, members, workspace, project };
}

it('creates a workspace from a stable request ID and scopes context to current membership', async () => {
  const { app, workspaces, members, workspace, project } = createApp();
  const body = { name: 'Personal workspace', requestId: workspace.id };
  const headers = { 'X-Account': 'account-1', 'Content-Type': 'application/json' };
  const created = await app.request('http://localhost/api/workspaces', {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  });
  expect(created.status).toBe(201);
  expect(await created.json()).toEqual({
    workspace,
    project: expect.objectContaining({ id: project.id, workspaceId: workspace.id }),
  });
  expect(workspaces.create).toHaveBeenCalledWith(
    expect.objectContaining({
      workspace: expect.objectContaining({
        id: workspace.id,
        name: workspace.name,
        createdBy: 'account-1',
      }),
      project: expect.objectContaining({ id: project.id, workspaceId: workspace.id }),
      owner: expect.objectContaining({ workspaceId: workspace.id, userId: 'account-1', role: 'owner' }),
      notepad: expect.objectContaining({
        id: `${workspace.id}-welcome`,
        projectId: project.id,
        workspaceId: workspace.id,
      }),
    }),
  );

  const context = await app.request(`http://localhost/api/workspaces/${workspace.id}`, {
    headers: { 'X-Account': 'account-1' },
  });
  expect(context.status).toBe(200);
  expect(await context.json()).toEqual({ workspace, role: 'owner' });
  expect(members.findByUserId).toHaveBeenCalledWith(workspace.id, 'account-1');
  expect((await app.request(`http://localhost/api/workspaces/${workspace.id}`)).status).toBe(401);
  expect(
    (await app.request('http://localhost/api/workspaces/foreign', {
      headers: { 'X-Account': 'account-1' },
    })).status,
  ).toBe(404);
});

it('requires owner role for rename and relies on the repository to recheck it atomically', async () => {
  const { app, workspaces, workspace } = createApp('viewer', true);
  const response = await app.request(`http://localhost/api/workspaces/${workspace.id}`, {
    method: 'PATCH',
    headers: { 'X-Account': 'account-1', 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'New name' }),
  });
  expect(response.status).toBe(403);
  expect(workspaces.rename).not.toHaveBeenCalled();
});

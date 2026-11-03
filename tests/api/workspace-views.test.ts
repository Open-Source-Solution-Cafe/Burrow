import { env } from 'cloudflare:test';
import { expect, it } from 'vitest';
import { createWorkerApp } from '../../src/worker';
import { getAccountWorkspaceScope } from './account-scope';

const app = createWorkerApp(env);

it('scopes workspace search, suggestions and task aggregates to the requested membership', async () => {
  const request = (path: string, cookie = '', init: RequestInit = {}) => {
    const headers = new Headers(init.headers);
    if (cookie) headers.set('Cookie', cookie);
    if (init.body !== undefined) headers.set('Content-Type', 'application/json');
    return app.request(`http://localhost${path}`, { ...init, headers }, env);
  };
  const post = (path: string, body: unknown, cookie = '') =>
    request(path, cookie, { method: 'POST', body: JSON.stringify(body) });

  const signup = await post('/api/auth/sign-up/email', {
    name: 'Workspace views owner',
    email: 'workspace-views-owner@example.test',
    password: 'password123',
    bootstrapToken: env.BOOTSTRAP_TOKEN || 'test-bootstrap-token',
  });
  expect(signup.status).toBe(200);
  const cookie = signup.headers.get('set-cookie')!;
  const scope = await getAccountWorkspaceScope(async (path) => request(path, cookie));
  const workspaceA = scope.workspaceId;
  const projectA = scope.projectId;

  const createdWorkspace = await post(
    '/api/workspaces',
    { name: 'Workspace views B', requestId: crypto.randomUUID() },
    cookie,
  );
  expect(createdWorkspace.status).toBe(201);
  const created = (await createdWorkspace.json()) as {
    workspace: { id: string };
    project: { id: string };
  };
  const workspaceB = created.workspace.id;
  const projectB = created.project.id;
  const noteB = await post(
    `/api/workspaces/${workspaceB}/projects/${projectB}/notepads`,
    { title: 'workspace-only-aggregate-token' },
    cookie,
  );
  expect(noteB.status).toBe(201);

  const searchA = await request(`/api/workspaces/${workspaceA}/search?q=workspace-only-aggregate-token`, cookie);
  const searchB = await request(`/api/workspaces/${workspaceB}/search?q=workspace-only-aggregate-token`, cookie);
  expect(searchA.status).toBe(200);
  expect(await searchA.json()).toEqual([]);
  expect(searchB.status).toBe(200);
  expect(await searchB.json()).toMatchObject([{ projectId: projectB }]);

  const scopedProjectSearch = await request(
    `/api/workspaces/${workspaceA}/search?q=workspace-only-aggregate-token&scope=project&projectId=${projectB}`,
    cookie,
  );
  expect(scopedProjectSearch.status).toBe(404);
  const suggestions = await request(
    `/api/workspaces/${workspaceB}/suggest?type=notepad&q=workspace-only-aggregate-token&projectId=${projectB}`,
    cookie,
  );
  expect(suggestions.status).toBe(200);
  expect(await suggestions.json()).toMatchObject([{ label: 'workspace-only-aggregate-token' }]);

  const boardResponse = await post(
    `/api/workspaces/${workspaceB}/projects/${projectB}/boards`,
    { name: 'Workspace B tasks' },
    cookie,
  );
  expect(boardResponse.status).toBe(201);
  const board = (await boardResponse.json()) as { id: string };
  const boardDetailsResponse = await request(
    `/api/workspaces/${workspaceB}/projects/${projectB}/boards/${board.id}`,
    cookie,
  );
  expect(boardDetailsResponse.status).toBe(200);
  const boardDetails = (await boardDetailsResponse.json()) as { columns: Array<{ id: string }> };
  expect(boardDetails.columns[0]?.id).toBeTruthy();
  const taskCreateResponse = await post(
    `/api/workspaces/${workspaceB}/projects/${projectB}/columns/${boardDetails.columns[0]!.id}/cards`,
    { title: 'Workspace B task', assigneeIds: [scope.userId] },
    cookie,
  );
  expect(taskCreateResponse.status).toBe(201);

  const tasksA = await request(`/api/workspaces/${workspaceA}/my-tasks`, cookie);
  const tasksB = await request(`/api/workspaces/${workspaceB}/my-tasks`, cookie);
  expect(tasksA.status).toBe(200);
  expect(tasksB.status).toBe(200);
  expect(await tasksA.json()).toEqual([]);
  expect(await tasksB.json()).toMatchObject([{ projectId: projectB, title: 'Workspace B task' }]);
  expect(projectA).not.toBe(projectB);
});

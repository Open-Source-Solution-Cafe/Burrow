import { env } from 'cloudflare:test';
import { expect, it } from 'vitest';
import { createWorkerApp } from '../../src/worker';
import { createDb } from '../../src/core/adapters/db/d1/client';
import * as schema from '../../src/core/adapters/db/d1/schema';
import { getAccountWorkspaceScope } from './account-scope';

it('never returns a board whose workspace disagrees with its project', async () => {
  const app = createWorkerApp(env);
  const db = createDb(env.DB);
  const signup = await app.request(
    'http://localhost/api/auth/sign-up/email',
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        email: 'board-source-scope-owner@example.test',
        name: 'Board scope owner',
        password: 'password123',
        bootstrapToken: env.BOOTSTRAP_TOKEN || 'test-bootstrap-token',
      }),
    },
    env,
  );
  expect(signup.status).toBe(200);
  const cookie = signup.headers.get('set-cookie')!;
  const request = (path: string) =>
    app.request(`http://localhost${path}`, { headers: { Cookie: cookie } }, env);
  const scope = await getAccountWorkspaceScope(async (path) => request(path));
  const { workspaceId, projectId } = scope;
  const foreignWorkspace = crypto.randomUUID();
  const foreignProject = crypto.randomUUID();
  const foreignProjectBoard = crypto.randomUUID();
  const foreignWorkspaceBoard = crypto.randomUUID();
  const foreignWorkspaceTrash = crypto.randomUUID();
  const localBoard = crypto.randomUUID();
  const localTrash = crypto.randomUUID();
  const now = Date.now();
  await db.insert(schema.workspaces).values({
    id: foreignWorkspace,
    name: 'Other workspace',
    createdBy: scope.userId,
    createdAt: now,
  });
  await db.insert(schema.projects).values({
    id: foreignProject,
    workspaceId: foreignWorkspace,
    name: 'Other project',
    position: 'a0',
    createdAt: now,
    updatedAt: now,
  });
  // With composite foreign keys (project_id, workspace_id) enforced in D1,
  // cross-scope boards whose workspace disagrees with their project are rejected at the DB level.
  await expect(
    db.insert(schema.boards).values({
      id: foreignProjectBoard,
      workspaceId,
      projectId: foreignProject,
      name: 'Other project board',
      position: 'a0',
      createdAt: now,
      updatedAt: now,
    }),
  ).rejects.toThrow();

  await expect(
    db.insert(schema.boards).values({
      id: foreignWorkspaceBoard,
      workspaceId: foreignWorkspace,
      projectId,
      name: 'Other workspace board',
      position: 'a1',
      createdAt: now,
      updatedAt: now,
    }),
  ).rejects.toThrow();

  await expect(
    db.insert(schema.boards).values({
      id: foreignWorkspaceTrash,
      workspaceId: foreignWorkspace,
      projectId,
      name: 'Other workspace trashed board',
      position: 'a2',
      deletedAt: now,
      createdAt: now,
      updatedAt: now,
    }),
  ).rejects.toThrow();

  // Valid local boards insert cleanly
  await db.insert(schema.boards).values([
    {
      id: localBoard,
      workspaceId,
      projectId,
      name: 'Local board',
      position: 'a3',
      createdAt: now,
      updatedAt: now,
    },
    {
      id: localTrash,
      workspaceId,
      projectId,
      name: 'Local trashed board',
      position: 'a4',
      deletedAt: now,
      createdAt: now,
      updatedAt: now,
    },
  ]);

  expect((await request(`/api/workspaces/${workspaceId}/projects/${projectId}/boards/${foreignProjectBoard}`)).status).toBe(404);
  expect((await request(`/api/workspaces/${workspaceId}/projects/${projectId}/boards/${foreignWorkspaceBoard}`)).status).toBe(404);
  expect((await request(`/api/workspaces/${workspaceId}/projects/${projectId}/boards/${localBoard}`)).status).toBe(200);
  expect((await request(`/api/workspaces/${workspaceId}/projects/${foreignProject}/boards`)).status).toBe(404);

  const list = await request(`/api/workspaces/${workspaceId}/projects/${projectId}/boards`);
  expect(list.status).toBe(200);
  const boardIds = ((await list.json()) as Array<{ id: string }>).map((board) => board.id);
  expect(boardIds).toContain(localBoard);
  expect(boardIds).not.toContain(foreignWorkspaceBoard);
  expect(boardIds).not.toContain(foreignWorkspaceTrash);

  const trash = await request(`/api/workspaces/${workspaceId}/projects/${projectId}/trash`);
  expect(trash.status).toBe(200);
  const trashed = (await trash.json()) as { boards: Array<{ id: string }> };
  const trashedIds = trashed.boards.map((board) => board.id);
  expect(trashedIds).toContain(localTrash);
  expect(trashedIds).not.toContain(foreignWorkspaceTrash);
});

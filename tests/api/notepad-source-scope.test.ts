import { env } from 'cloudflare:test';
import { expect, it } from 'vitest';
import { createWorkerApp } from '../../src/worker';
import { createDb } from '../../src/core/adapters/db/d1/client';
import * as schema from '../../src/core/adapters/db/d1/schema';
import { getAccountWorkspaceScope } from './account-scope';

it('never returns a note whose workspace disagrees with its project', async () => {
  const app = createWorkerApp(env);
  const db = createDb(env.DB);
  const signup = await app.request(
    'http://localhost/api/auth/sign-up/email',
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        email: 'source-scope-owner@example.test',
        name: 'Source scope owner',
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
  const scope = await getAccountWorkspaceScope(request);

  const { workspaceId, projectId } = scope;
  const foreignWorkspace = crypto.randomUUID();
  const foreignProject = crypto.randomUUID();
  const wrongProjectNote = crypto.randomUUID();
  const wrongWorkspaceNote = crypto.randomUUID();
  const wrongWorkspaceTrash = crypto.randomUUID();
  const legitimateTrash = crypto.randomUUID();
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
  // Simulate corrupt legacy rows whose individual foreign keys still exist.
  // Bypass only the notepad scope insert guard and restore its exact definition.
  const guard = await env.DB.prepare(
    "SELECT sql FROM sqlite_master WHERE type = 'trigger' AND name = ?",
  ).bind('notepads_scope_insert_guard').first<{ sql: string }>();
  expect(guard?.sql).toBeTruthy();
  await env.DB.prepare('DROP TRIGGER notepads_scope_insert_guard').run();
  try {
    await db.insert(schema.notepads).values([
    {
      id: wrongProjectNote,
      workspaceId,
      projectId: foreignProject,
      title: 'Foreign project content',
      content: '[{"secret":"foreign"}]',
      position: 'a1',
      createdBy: scope.userId,
      createdAt: now,
      updatedAt: now,
    },
    {
      id: wrongWorkspaceNote,
      workspaceId: foreignWorkspace,
      projectId,
      title: 'Foreign workspace content',
      position: 'a2',
      createdBy: scope.userId,
      createdAt: now,
      updatedAt: now,
    },
    {
      id: wrongWorkspaceTrash,
      workspaceId: foreignWorkspace,
      projectId,
      title: 'Foreign workspace trash',
      position: 'a3',
      deletedAt: now,
      createdBy: scope.userId,
      createdAt: now,
      updatedAt: now,
    },
    {
      id: legitimateTrash,
      workspaceId,
      projectId,
      title: 'Local trash',
      position: 'a4',
      deletedAt: now,
      createdBy: scope.userId,
      createdAt: now,
      updatedAt: now,
    },
    ]);
  } finally {
    await env.DB.prepare(guard!.sql!).run();
  }

  expect((await request(`/api/workspaces/${workspaceId}/projects/${projectId}/notepads/${wrongProjectNote}`)).status).toBe(404);
  expect(
    (await request(`/api/workspaces/${workspaceId}/projects/${projectId}/notepads/${wrongProjectNote}`)).status,
  ).toBe(404);
  expect((await request(`/api/workspaces/${workspaceId}/projects/${projectId}/notepads/${wrongWorkspaceNote}`)).status).toBe(404);
  expect((await request(`/api/workspaces/${workspaceId}/projects/${foreignProject}/notepads`)).status).toBe(404);

  const tree = await request(`/api/workspaces/${workspaceId}/projects/${projectId}/notepads`);
  expect(tree.status).toBe(200);
  const notes = (await tree.json()) as Array<{ id: string }>;
  expect(notes.length).toBeGreaterThan(0); // The legitimate starter note remains visible.
  expect(notes.map((note) => note.id)).not.toContain(wrongWorkspaceNote);
  expect((await request(`/api/workspaces/${workspaceId}/projects/${projectId}/notepads/${notes[0]!.id}`)).status).toBe(200);

  const trash = await request(`/api/workspaces/${workspaceId}/projects/${projectId}/trash`);
  expect(trash.status).toBe(200);
  const trashed = (await trash.json()) as { notepads: Array<{ id: string }> };
  expect(trashed.notepads.map((note) => note.id)).toContain(legitimateTrash);
  expect(trashed.notepads.map((note) => note.id)).not.toContain(wrongWorkspaceTrash);
});

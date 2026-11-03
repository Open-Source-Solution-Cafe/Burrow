import { env } from 'cloudflare:test';
import { eq } from 'drizzle-orm';
import { expect, it } from 'vitest';
import { createWorkerApp } from '../../src/worker';
import { createDb } from '../../src/core/adapters/db/d1/client';
import * as schema from '../../src/core/adapters/db/d1/schema';
import { getAccountWorkspaceScope } from './account-scope';

it('rejects cards with inconsistent source relationships across card and aggregate endpoints', async () => {
  const app = createWorkerApp(env);
  const db = createDb(env.DB);
  let cookie = '';
  const request = (path: string, init: RequestInit = {}) => {
    const headers = new Headers(init.headers);
    if (cookie) headers.set('Cookie', cookie);
    if (init.body) headers.set('Content-Type', 'application/json');
    return app.request(`http://localhost${path}`, { ...init, headers }, env);
  };
  const post = (path: string, body: unknown) =>
    request(path, { method: 'POST', body: JSON.stringify(body) });
  const json = async <T>(response: Response, status: number): Promise<T> => {
    expect(response.status).toBe(status);
    return response.json() as Promise<T>;
  };

  const signup = await post('/api/auth/sign-up/email', {
    email: 'card-source-scope@example.test', name: 'Card source owner',
    password: 'password123', bootstrapToken: env.BOOTSTRAP_TOKEN || 'test-bootstrap-token',
  });
  expect(signup.status).toBe(200);
  cookie = signup.headers.get('set-cookie')!;
  const scope = await getAccountWorkspaceScope(async (path) => request(path));
  const projectId = scope.projectId;
  const otherProject = await json<{ id: string }>(await post(`/api/workspaces/${scope.workspaceId}/projects`, { name: 'Other project' }), 201);
  const projectPath = `/api/workspaces/${scope.workspaceId}/projects/${projectId}`;
  const board = await json<{ id: string }>(await post(`${projectPath}/boards`, { name: 'Board' }), 201);
  const otherBoard = await json<{ id: string }>(await post(`${projectPath}/boards`, { name: 'Other board' }), 201);
  const detail = await json<{ columns: Array<{ id: string }> }>(await request(`${projectPath}/boards/${board.id}`), 200);
  const otherDetail = await json<{ columns: Array<{ id: string }> }>(await request(`${projectPath}/boards/${otherBoard.id}`), 200);
  const column = detail.columns[0]!.id;
  const otherColumn = otherDetail.columns[0]!.id;

  const cards = [];
  for (const name of ['valid', 'project', 'workspace', 'kind', 'column']) {
    cards.push(await json<{ cardId: string; notepadId: string }>(
      await post(`${projectPath}/columns/${column}/cards`, { title: `Scope ${name}`, assigneeIds: [scope.userId] }), 201,
    ));
  }
  const [valid, wrongProject, wrongWorkspace, wrongKind, wrongColumn] = cards;
  const foreignWorkspace = crypto.randomUUID();
  await db.insert(schema.workspaces).values({ id: foreignWorkspace, name: 'Foreign', createdBy: scope.userId, createdAt: Date.now() });
  // Model legacy relationship corruption while briefly bypassing only the two
  // guards for fields deliberately made inconsistent in this fixture.
  const notepadGuard = await env.DB.prepare(
    "SELECT sql FROM sqlite_master WHERE type = 'trigger' AND name = ?",
  ).bind('notepads_scope_update_guard').first<{ sql: string }>();
  const cardGuard = await env.DB.prepare(
    "SELECT sql FROM sqlite_master WHERE type = 'trigger' AND name = ?",
  ).bind('cards_scope_update_guard').first<{ sql: string }>();
  expect(notepadGuard?.sql).toBeTruthy();
  expect(cardGuard?.sql).toBeTruthy();
  await env.DB.batch([
    env.DB.prepare('DROP TRIGGER notepads_scope_update_guard'),
    env.DB.prepare('DROP TRIGGER cards_scope_update_guard'),
  ]);
  try {
    await db.update(schema.notepads).set({ projectId: otherProject.id }).where(eq(schema.notepads.id, wrongProject!.notepadId));
    await db.update(schema.notepads).set({ workspaceId: foreignWorkspace }).where(eq(schema.notepads.id, wrongWorkspace!.notepadId));
    await db.update(schema.notepads).set({ kind: 'notepad' }).where(eq(schema.notepads.id, wrongKind!.notepadId));
    await db.update(schema.cards).set({ columnId: otherColumn }).where(eq(schema.cards.id, wrongColumn!.cardId));
  } finally {
    await env.DB.batch([
      env.DB.prepare(notepadGuard!.sql!),
      env.DB.prepare(cardGuard!.sql!),
    ]);
  }

  const badIds = cards.slice(1).map((card) => card.cardId);
  for (const id of badIds) {
    expect((await request(`${projectPath}/cards/${id}`)).status).toBe(404);
    expect((await request(`${projectPath}/cards/${id}`, { method: 'PATCH', body: JSON.stringify({ priority: 'high' }) })).status).toBe(404);
    expect((await request(`${projectPath}/cards/${id}/comments`)).status).toBe(404);
    expect((await post(`${projectPath}/cards/${id}/comments`, { content: 'Must not write' })).status).toBe(404);
  }
  expect((await request(`${projectPath}/cards/${valid!.cardId}`)).status).toBe(200);

  for (const boardId of [board.id, otherBoard.id]) {
    const result = await json<{ columns: Array<{ cards: Array<{ id: string }> }> }>(await request(`${projectPath}/boards/${boardId}`), 200);
    const ids = result.columns.flatMap((item) => item.cards.map((card) => card.id));
    for (const id of badIds) expect(ids).not.toContain(id);
    if (boardId === board.id) expect(ids).toContain(valid!.cardId);
  }
  for (const path of [
    `/api/workspaces/${scope.workspaceId}/suggest?type=card&projectId=${projectId}&q=Scope`,
    `/api/workspaces/${scope.workspaceId}/my-tasks`,
    `${projectPath}/cards/summary?ids=${cards.map((card) => card.cardId).join(',')}`,
  ]) {
    const result = await json<Array<{ id: string }>>(await request(path), 200);
    const ids = result.map((item) => item.id);
    expect(ids).toContain(valid!.cardId);
    for (const id of badIds) expect(ids).not.toContain(id);
  }
});

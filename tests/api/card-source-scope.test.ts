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
  // With composite foreign keys and triggers enforced in D1,
  // database integrity rejects cross-scope tampering at the DB layer:
  // 1. Changing notepad.projectId to another project violates fk_cards_notepad_project_kind
  await expect(
    db.update(schema.notepads).set({ projectId: otherProject.id }).where(eq(schema.notepads.id, wrongProject!.notepadId)),
  ).rejects.toThrow();

  // 2. Changing notepad.workspaceId to a foreign workspace violates fk_notepads_project_workspace
  await expect(
    db.update(schema.notepads).set({ workspaceId: foreignWorkspace }).where(eq(schema.notepads.id, wrongWorkspace!.notepadId)),
  ).rejects.toThrow();

  // 3. Changing notepad.kind from 'card' to 'notepad' violates fk_cards_notepad_project_kind
  await expect(
    db.update(schema.notepads).set({ kind: 'notepad' }).where(eq(schema.notepads.id, wrongKind!.notepadId)),
  ).rejects.toThrow();

  // 4. Changing card.columnId to a column from another board violates fk_cards_board_column
  await expect(
    db.update(schema.cards).set({ columnId: otherColumn }).where(eq(schema.cards.id, wrongColumn!.cardId)),
  ).rejects.toThrow();

  // Valid card remains healthy and accessible
  expect((await request(`${projectPath}/cards/${valid!.cardId}`)).status).toBe(200);

  for (const boardId of [board.id, otherBoard.id]) {
    const result = await json<{ columns: Array<{ cards: Array<{ id: string }> }> }>(await request(`${projectPath}/boards/${boardId}`), 200);
    const ids = result.columns.flatMap((item) => item.cards.map((card) => card.id));
    if (boardId === board.id) {
      for (const card of cards) expect(ids).toContain(card.cardId);
    } else {
      for (const card of cards) expect(ids).not.toContain(card.cardId);
    }
  }
  for (const path of [
    `/api/workspaces/${scope.workspaceId}/suggest?type=card&projectId=${projectId}&q=Scope`,
    `/api/workspaces/${scope.workspaceId}/my-tasks`,
    `${projectPath}/cards/summary?ids=${cards.map((card) => card.cardId).join(',')}`,
  ]) {
    const result = await json<Array<{ id: string }>>(await request(path), 200);
    const ids = result.map((item) => item.id);
    for (const card of cards) expect(ids).toContain(card.cardId);
  }
});

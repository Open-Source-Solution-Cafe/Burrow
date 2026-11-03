import { env } from 'cloudflare:test';
import { eq } from 'drizzle-orm';
import { expect, it } from 'vitest';
import { createWorkerApp } from '../../src/worker';
import { createDb } from '../../src/core/adapters/db/d1/client';
import * as t from '../../src/core/adapters/db/d1/schema';
import { getAccountWorkspaceScope } from './account-scope';

it('exposes only workspace-member assignees and lock-holder identity on card and board reads', async () => {
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
  const signup = await post('/api/auth/sign-up/email', {
    name: 'Local owner',
    email: 'card-assignee-scope@example.test',
    password: 'password123',
    bootstrapToken: env.BOOTSTRAP_TOKEN,
  });
  expect(signup.status).toBe(200);
  cookie = signup.headers.get('set-cookie')!;
  const scope = await getAccountWorkspaceScope(async (path) => request(path));
  const boardResponse = await post(`/api/workspaces/${scope.workspaceId}/projects/${scope.projectId}/boards`, {
    name: 'Card scope board',
  });
  expect(boardResponse.status).toBe(201);
  const { id: boardId } = (await boardResponse.json()) as { id: string };
  const board = (await (await request(`/api/workspaces/${scope.workspaceId}/projects/${scope.projectId}/boards/${boardId}`)).json()) as {
    columns: Array<{ id: string }>;
  };
  const cardResponse = await post(`/api/workspaces/${scope.workspaceId}/projects/${scope.projectId}/columns/${board.columns[0]!.id}/cards`, {
    title: 'Card scope',
    assigneeIds: [scope.userId],
  });
  expect(cardResponse.status).toBe(201);
  const { cardId, notepadId } = (await cardResponse.json()) as {
    cardId: string;
    notepadId: string;
  };

  const now = Date.now();
  const foreignUser = crypto.randomUUID();
  const foreignWorkspace = crypto.randomUUID();
  await db.insert(t.user).values({
    id: foreignUser,
    name: 'Private foreign user',
    email: 'foreign-card-assignee@example.test',
    createdAt: new Date(now),
    updatedAt: new Date(now),
  });
  await db.insert(t.workspaces).values({
    id: foreignWorkspace,
    name: 'Foreign workspace',
    createdBy: foreignUser,
    createdAt: now,
  });
  await db.insert(t.members).values({
    workspaceId: foreignWorkspace,
    userId: foreignUser,
    role: 'owner',
    joinedAt: now,
  });
  // Simulate corrupt legacy data: neither foreign assignment nor lock implies access.
  // Bypass only the assignment guard and restore its exact definition.
  const guard = await env.DB.prepare(
    "SELECT sql FROM sqlite_master WHERE type = 'trigger' AND name = ?",
  ).bind('card_assignees_scope_insert_guard').first<{ sql: string }>();
  expect(guard?.sql).toBeTruthy();
  await env.DB.prepare('DROP TRIGGER card_assignees_scope_insert_guard').run();
  try {
    await db.insert(t.cardAssignees).values({ cardId, userId: foreignUser });
  } finally {
    await env.DB.prepare(guard!.sql!).run();
  }
  await db.insert(t.editLocks).values({
    notepadId,
    userId: foreignUser,
    clientId: 'foreign-private-client',
    expiresAt: now + 60_000,
  });

  const detailResponse = await request(`/api/workspaces/${scope.workspaceId}/projects/${scope.projectId}/cards/${cardId}`);
  expect(detailResponse.status).toBe(200);
  const detail = (await detailResponse.json()) as {
    assignees: Array<{ userId: string; name: string }>;
    lock: Record<string, unknown>;
  };
  expect(detail.assignees).toEqual([
    expect.objectContaining({ userId: scope.userId, name: 'Local owner' }),
  ]);
  expect(detail.lock).toEqual({ name: 'Someone', expiresAt: expect.any(Number) });

  const boardDetailResponse = await request(`/api/workspaces/${scope.workspaceId}/projects/${scope.projectId}/boards/${boardId}`);
  expect(boardDetailResponse.status).toBe(200);
  const boardDetail = (await boardDetailResponse.json()) as {
    columns: Array<{ cards: Array<{ id: string; assignees: Array<{ userId: string }> }> }>;
  };
  const boardCard = boardDetail.columns
    .flatMap((column) => column.cards)
    .find((c) => c.id === cardId);
  expect(boardCard?.assignees).toEqual([expect.objectContaining({ userId: scope.userId })]);

  await db
    .update(t.editLocks)
    .set({ userId: scope.userId, clientId: 'local-client' })
    .where(eq(t.editLocks.notepadId, notepadId));
  const localDetail = (await (await request(`/api/workspaces/${scope.workspaceId}/projects/${scope.projectId}/cards/${cardId}`)).json()) as {
    lock: Record<string, unknown>;
  };
  expect(localDetail.lock).toEqual({
    userId: scope.userId,
    clientId: 'local-client',
    name: 'Local owner',
    expiresAt: expect.any(Number),
  });
});

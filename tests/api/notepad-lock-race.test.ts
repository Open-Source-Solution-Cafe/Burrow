import { env } from 'cloudflare:test';
import { expect, it } from 'vitest';
import { createWorkerApp } from '../../src/worker';
import { createCoreApp } from '../../src/core/app';
import { createD1Infrastructure } from '../../src/core/adapters/db/d1';
import { createDb } from '../../src/core/adapters/db/d1/client';
import { getAccountWorkspaceScope } from './account-scope';

it('returns 409 without changes when another client acquires a lock after the early check', async () => {
  const app = createWorkerApp(env);
  const signup = await app.request(
    'http://localhost/api/auth/sign-up/email',
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: 'Lock owner',
        email: 'lock-race@example.test',
        password: 'password123',
        bootstrapToken: env.BOOTSTRAP_TOKEN,
      }),
    },
    env,
  );
  expect(signup.status).toBe(200);
  const cookie = signup.headers.get('set-cookie')!;
  const scope = await getAccountWorkspaceScope((path) =>
    app.request(`http://localhost${path}`, { headers: { Cookie: cookie } }, env),
  );
  const create = await app.request(
    `http://localhost/api/workspaces/${scope.workspaceId}/projects/${scope.projectId}/notepads`,
    {
      method: 'POST',
      headers: { Cookie: cookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: 'Quokka original' }),
    },
    env,
  );
  expect(create.status).toBe(201);
  const { id } = (await create.json()) as { id: string };
  const memberId = crypto.randomUUID();
  await env.DB.prepare(
    "INSERT INTO members (workspace_id, user_id, role, joined_at) VALUES (?, ?, 'editor', ?)",
  )
    .bind(scope.workspaceId, memberId, Date.now())
    .run();
  const infra = createD1Infrastructure(createDb(env.DB), env);
  const readLock = infra.repositories.notepads.getLock;
  let raced = false;
  infra.repositories.notepads.getLock = async (projectScope, notepadId) => {
    const snapshot = await readLock(projectScope, notepadId);
    if (!raced && notepadId === id) {
      raced = true;
      expect((await infra.locks.acquire(id, scope.userId, 'other-client', 60_000)).acquired).toBe(
        true,
      );
    }
    return snapshot;
  };
  const content = JSON.stringify([
    {
      type: 'paragraph',
      content: [
        { type: 'mention', props: { kind: 'user', id: memberId, label: 'Member' } },
        { type: 'text', text: 'gazelle replacement' },
      ],
    },
  ]);
  const response = await createCoreApp(infra).request(
    `http://localhost/api/workspaces/${scope.workspaceId}/projects/${scope.projectId}/notepads/${id}/content`,
    {
      method: 'PUT',
      headers: { Cookie: cookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({ content, baseVersion: 1, clientId: 'original' }),
    },
    env,
  );
  expect(response.status).toBe(409);
  expect(await response.json()).toMatchObject({
    error: { code: 'locked', holder: { userId: scope.userId, isMe: true } },
  });
  expect(await infra.repositories.notepads.findByIdInScope(scope, id)).toMatchObject({
    content: '[]',
    version: 1,
  });
  expect(await infra.repositories.notepads.listLinks(scope, id)).toEqual([]);
  expect(await readLock(scope, id)).toMatchObject({ userId: scope.userId, clientId: 'other-client' });
  expect(
    (await env.DB.prepare('SELECT id FROM notifications WHERE notepad_id = ?').bind(id).all())
      .results,
  ).toEqual([]);
  expect(
    await infra.search.search({
      workspaceId: scope.workspaceId,
      projectId: scope.projectId,
      text: 'gazelle',
    }),
  ).toEqual([]);
  expect(
    (
      await infra.search.search({
        workspaceId: scope.workspaceId,
        projectId: scope.projectId,
        text: 'quokka',
      })
    ).map((hit) => hit.id),
  ).toContain(id);
});

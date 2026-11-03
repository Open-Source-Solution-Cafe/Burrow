import { env } from 'cloudflare:test';
import { expect, it } from 'vitest';
import { createWorkerApp } from '../../src/worker';
import { createCoreApp } from '../../src/core/app';
import { createD1Infrastructure } from '../../src/core/adapters/db/d1';
import { createDb } from '../../src/core/adapters/db/d1/client';
import { getAccountWorkspaceScope } from './account-scope';

it('does not update a board when editor membership is revoked between route check and repository write', async () => {
  const app = createWorkerApp(env);
  const request = (path: string, cookie = '', method = 'GET', body?: unknown) => {
    const headers = new Headers();
    if (cookie) headers.set('Cookie', cookie);
    if (body !== undefined) headers.set('Content-Type', 'application/json');
    return app.request(`http://localhost${path}`, {
      method,
      headers,
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }, env);
  };
  const signup = await request('/api/auth/sign-up/email', '', 'POST', {
    email: 'board-write-owner@example.test',
    name: 'Board write owner',
    password: 'password123',
    bootstrapToken: env.BOOTSTRAP_TOKEN || 'test-bootstrap-token',
  });
  expect(signup.status).toBe(200);
  const cookie = signup.headers.get('set-cookie')!;
  const scope = await getAccountWorkspaceScope(async (path) => request(path, cookie));
  const boardResponse = await request(
    `/api/workspaces/${scope.workspaceId}/projects/${scope.projectId}/boards`,
    cookie,
    'POST',
    { name: 'Before revocation' },
  );
  expect(boardResponse.status).toBe(201);
  const { id: boardId } = (await boardResponse.json()) as { id: string };

  const infrastructure = createD1Infrastructure(createDb(env.DB), env);
  const repository = infrastructure.repositories.boards;
  const update = repository.updateGuarded.bind(repository);
  repository.updateGuarded = async (...args) => {
    await env.DB.prepare('UPDATE members SET role = ? WHERE workspace_id = ? AND user_id = ?')
      .bind('viewer', scope.workspaceId, scope.userId).run();
    return update(...args);
  };
  const response = await createCoreApp(infrastructure).request(
    `http://localhost/api/workspaces/${scope.workspaceId}/projects/${scope.projectId}/boards/${boardId}`,
    {
      method: 'PATCH',
      headers: { Cookie: cookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Must remain unchanged' }),
    },
  );
  expect(response.status).toBe(403);
  expect(await env.DB.prepare('SELECT name FROM boards WHERE id = ?').bind(boardId).first())
    .toMatchObject({ name: 'Before revocation' });
});

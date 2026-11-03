import { env } from 'cloudflare:test';
import { expect, it } from 'vitest';
import { createWorkerApp } from '../../src/worker';
import { createCoreApp } from '../../src/core/app';
import { createD1Infrastructure } from '../../src/core/adapters/db/d1';
import { createDb } from '../../src/core/adapters/db/d1/client';
import { getAccountWorkspaceScope } from './account-scope';

it('enforces explicit workspace scope for project mutations', async () => {
  const app = createWorkerApp(env);
  const request = (path: string, cookie = '', method = 'GET', body?: unknown) => {
    const headers = new Headers();
    if (cookie) headers.set('Cookie', cookie);
    if (body !== undefined) headers.set('Content-Type', 'application/json');
    return app.request(
      `http://localhost${path}`,
      {
        method,
        headers,
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      },
      env,
    );
  };
  const owner = await request('/api/auth/sign-up/email', '', 'POST', {
    name: 'Owner',
    email: 'scoped-project-owner@example.test',
    password: 'password123',
    bootstrapToken: env.BOOTSTRAP_TOKEN || 'test-bootstrap-token',
  });
  expect(owner.status).toBe(200);
  const ownerCookie = owner.headers.get('set-cookie')!;
  const ownerScope = await getAccountWorkspaceScope(async (path) => request(path, ownerCookie));
  const workspaceId = ownerScope.workspaceId;
  const projectId = ownerScope.projectId;
  const scoped = `/api/workspaces/${workspaceId}/projects`;
  const join = async (email: string, role: 'editor' | 'viewer') => {
    const invite = await request(`/api/workspaces/${workspaceId}/invites`, ownerCookie, 'POST', { email, role });
    expect(invite.status).toBe(200);
    const { token } = (await invite.json()) as { token: string };
    const signup = await request('/api/auth/sign-up/email', '', 'POST', {
      name: role,
      email,
      password: 'password123',
      inviteToken: token,
    });
    expect(signup.status).toBe(200);
    return signup.headers.get('set-cookie')!;
  };
  const viewerCookie = await join('scoped-project-viewer@example.test', 'viewer');
  const editorCookie = await join('scoped-project-editor@example.test', 'editor');
  const editorId = (await getAccountWorkspaceScope(async (path) => request(path, editorCookie))).userId;
  const foreignWorkspace = crypto.randomUUID();
  const foreignProject = crypto.randomUUID();
  const now = Date.now();
  await env.DB.prepare(
    'INSERT INTO workspaces (id, name, created_by, created_at) VALUES (?, ?, ?, ?)',
  )
    .bind(foreignWorkspace, 'Foreign', ownerScope.userId, now)
    .run();
  await env.DB.prepare(
    'INSERT INTO projects (id, workspace_id, name, position, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)',
  )
    .bind(foreignProject, foreignWorkspace, 'Foreign project', 'a0', now, now)
    .run();
  const assertDenied = async (response: Response, status: number) => {
    expect(response.status).toBe(status);
    expect(response.headers.get('cache-control')).toBe('private, no-store');
  };

  await assertDenied(await request(scoped, '', 'POST', { name: 'Anonymous' }), 401);
  await assertDenied(
    await request(`/api/workspaces/${foreignWorkspace}/projects`, ownerCookie, 'POST', {
      name: 'Foreign',
    }),
    404,
  );
  await assertDenied(
    await request('/api/workspaces/missing/projects', ownerCookie, 'POST', { name: 'Missing' }),
    404,
  );
  await assertDenied(await request(scoped, viewerCookie, 'POST', { name: 'Viewer' }), 403);
  await assertDenied(
    await request(`${scoped}/${projectId}`, viewerCookie, 'PATCH', { name: 'Viewer' }),
    403,
  );
  await assertDenied(
    await request(`${scoped}/${projectId}/move`, viewerCookie, 'POST', { afterId: null }),
    403,
  );
  await assertDenied(
    await request(`${scoped}/${foreignProject}`, ownerCookie, 'PATCH', { name: 'Wrong project' }),
    404,
  );
  await assertDenied(
    await request(`${scoped}/${projectId}/move`, ownerCookie, 'POST', {
      afterId: foreignProject,
    }),
    400,
  );
  expect(
    await env.DB.prepare('SELECT name FROM projects WHERE id = ?').bind(foreignProject).first(),
  ).toMatchObject({ name: 'Foreign project' });

  const scopedCreate = await request(scoped, ownerCookie, 'POST', { name: 'Scoped create' });
  expect(scopedCreate.status).toBe(201);
  expect(scopedCreate.headers.get('cache-control')).toBe('private, no-store');
  const scopedBody = (await scopedCreate.json()) as { id: string; position: string };
  const secondScopedCreate = await request(scoped, ownerCookie, 'POST', {
    name: 'Second scoped create',
  });
  expect(secondScopedCreate.status).toBe(201);
  const secondScopedBody = (await secondScopedCreate.json()) as { id: string; position: string };
  const scopedUpdate = await request(`${scoped}/${scopedBody.id}`, ownerCookie, 'PATCH', {
    name: 'Scoped updated',
  });
  expect(scopedUpdate.status).toBe(200);
  expect(scopedUpdate.headers.get('cache-control')).toBe('private, no-store');
  const secondUpdate = await request(`${scoped}/${secondScopedBody.id}`, ownerCookie, 'PATCH', {
    name: 'Second scoped updated',
  });
  expect(secondUpdate.status).toBe(200);
  const scopedMove = await request(`${scoped}/${scopedBody.id}/move`, ownerCookie, 'POST', {
    afterId: null,
  });
  expect(scopedMove.status).toBe(200);
  expect(scopedMove.headers.get('cache-control')).toBe('private, no-store');
  const secondMove = await request(`${scoped}/${secondScopedBody.id}/move`, ownerCookie, 'POST', {
    afterId: null,
  });
  expect(secondMove.status).toBe(200);

  // Revoke the editor between route-level membership resolution and the write.
  const infra = createD1Infrastructure(createDb(env.DB), env);
  const repo = infra.repositories.projects;
  const update = repo.updateGuarded.bind(repo);
  repo.updateGuarded = async (...args) => {
    await env.DB.prepare(
      "UPDATE members SET role = 'viewer' WHERE workspace_id = ? AND user_id = ?",
    )
      .bind(workspaceId, editorId)
      .run();
    return update(...args);
  };
  const race = await createCoreApp(infra).request(
    `http://localhost${scoped}/${scopedBody.id}`,
    {
      method: 'PATCH',
      headers: { Cookie: editorCookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Demoted race' }),
    },
    env,
  );
  await assertDenied(race, 403);
  expect(
    await env.DB.prepare('SELECT name FROM projects WHERE id = ?').bind(scopedBody.id).first(),
  ).toMatchObject({ name: 'Scoped updated' });
});

import { env } from 'cloudflare:test';
import { beforeAll, describe, expect, it } from 'vitest';
import { createWorkerApp } from '../../src/worker';
import { createCoreApp } from '../../src/core/app';
import { createD1Infrastructure } from '../../src/core/adapters/db/d1';
import { createDb } from '../../src/core/adapters/db/d1/client';
import { getAccountWorkspaceScope } from './account-scope';

const app = createWorkerApp(env);

describe('project mutations enforce current workspace membership', () => {
  let ownerCookie = '';
  let editorCookie = '';
  let viewerCookie = '';
  let workspaceId = '';
  let editorId = '';
  let localId = '';
  let foreignId = '';

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

  beforeAll(async () => {
    const owner = await request('/api/auth/sign-up/email', '', 'POST', {
      name: 'Owner',
      email: 'project-guard-owner@example.test',
      password: 'password123',
      bootstrapToken: env.BOOTSTRAP_TOKEN || 'test-bootstrap-token',
    });
    expect(owner.status).toBe(200);
    ownerCookie = owner.headers.get('set-cookie')!;
    const ownerScope = await getAccountWorkspaceScope((path) => request(path, ownerCookie));
    workspaceId = ownerScope.workspaceId;
    localId = ownerScope.projectId;

    const join = async (email: string, role: 'editor' | 'viewer') => {
      const invitation = await request(`/api/workspaces/${workspaceId}/invites`, ownerCookie, 'POST', { email, role });
      expect(invitation.status).toBe(200);
      const { token } = (await invitation.json()) as { token: string };
      const signup = await request('/api/auth/sign-up/email', '', 'POST', {
        name: role,
        email,
        password: 'password123',
        inviteToken: token,
      });
      expect(signup.status).toBe(200);
      return signup.headers.get('set-cookie')!;
    };
    editorCookie = await join('project-guard-editor@example.test', 'editor');
    viewerCookie = await join('project-guard-viewer@example.test', 'viewer');
    editorId = (await getAccountWorkspaceScope((path) => request(path, editorCookie))).userId;

    const foreignWorkspace = crypto.randomUUID();
    foreignId = crypto.randomUUID();
    const now = Date.now();
    await env.DB.prepare(
      'INSERT INTO workspaces (id, name, created_by, created_at) VALUES (?, ?, ?, ?)',
    )
      .bind(foreignWorkspace, 'Foreign', ownerScope.userId, now)
      .run();
    await env.DB.prepare(
      'INSERT INTO projects (id, workspace_id, name, position, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)',
    )
      .bind(foreignId, foreignWorkspace, 'Foreign project', 'a0', now, now)
      .run();
  });

  it('rejects viewer writes, foreign targets and foreign ordering anchors', async () => {
    for (const [path, method, body] of [
      [`/api/workspaces/${workspaceId}/projects`, 'POST', { name: 'Viewer create' }],
      [`/api/workspaces/${workspaceId}/projects/${localId}`, 'PATCH', { name: 'Viewer update' }],
      [`/api/workspaces/${workspaceId}/projects/${localId}/move`, 'POST', { afterId: null }],
    ] as const) {
      expect((await request(path, viewerCookie, method, body)).status).toBe(403);
    }
    expect(
      (await request(`/api/workspaces/${workspaceId}/projects/${foreignId}`, ownerCookie, 'PATCH', { name: 'Invalid' }))
        .status,
    ).toBe(404);
    expect(
      (await request(`/api/workspaces/${workspaceId}/projects/${foreignId}/move`, ownerCookie, 'POST', { afterId: null }))
        .status,
    ).toBe(404);
    expect(
      (await request(`/api/workspaces/${workspaceId}/projects/${localId}/move`, ownerCookie, 'POST', { afterId: foreignId }))
        .status,
    ).toBe(400);
    expect(
      await env.DB.prepare('SELECT name FROM projects WHERE id = ?').bind(foreignId).first(),
    ).toMatchObject({ name: 'Foreign project' });
  });

  it('rejects writes when an editor is demoted or removed after route authorization', async () => {
    const infra = createD1Infrastructure(createDb(env.DB), env);
    const guarded = infra.repositories.projects;
    const originalCreate = guarded.createGuarded.bind(guarded);
    const originalUpdate = guarded.updateGuarded.bind(guarded);
    const originalMove = guarded.moveGuarded.bind(guarded);
    const setRole = async (role: 'editor' | 'viewer') => {
      await env.DB.prepare('UPDATE members SET role = ? WHERE workspace_id = ? AND user_id = ?')
        .bind(role, workspaceId, editorId)
        .run();
    };
    const raceApp = createCoreApp(infra);
    const raceRequest = (path: string, method: string, body: unknown) =>
      raceApp.request(
        `http://localhost${path}`,
        {
          method,
          headers: { Cookie: editorCookie, 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        },
        env,
      );
    const before = await env.DB.prepare(
      'SELECT name, position, archived_at FROM projects WHERE id = ?',
    )
      .bind(localId)
      .first();

    guarded.createGuarded = async (...args) => {
      await setRole('viewer');
      return originalCreate(...args);
    };
    expect((await raceRequest(`/api/workspaces/${workspaceId}/projects`, 'POST', { name: 'Denied race' })).status).toBe(403);
    expect(
      await env.DB.prepare('SELECT id FROM projects WHERE workspace_id = ? AND name = ?')
        .bind(workspaceId, 'Denied race')
        .first(),
    ).toBeNull();
    await setRole('editor');

    guarded.updateGuarded = async (...args) => {
      await env.DB.prepare('DELETE FROM members WHERE workspace_id = ? AND user_id = ?')
        .bind(workspaceId, editorId)
        .run();
      return originalUpdate(...args);
    };
    expect(
      (
        await raceRequest(`/api/workspaces/${workspaceId}/projects/${localId}`, 'PATCH', {
          name: 'Denied update',
          archived: true,
        })
      ).status,
    ).toBe(403);
    expect(
      await env.DB.prepare('SELECT name, position, archived_at FROM projects WHERE id = ?')
        .bind(localId)
        .first(),
    ).toEqual(before);
    await env.DB.prepare(
      "INSERT INTO members (workspace_id, user_id, role, joined_at) VALUES (?, ?, 'editor', ?)",
    )
      .bind(workspaceId, editorId, Date.now())
      .run();

    guarded.moveGuarded = async (...args) => {
      await setRole('viewer');
      return originalMove(...args);
    };
    expect(
      (await raceRequest(`/api/workspaces/${workspaceId}/projects/${localId}/move`, 'POST', { afterId: null })).status,
    ).toBe(403);
    expect(
      await env.DB.prepare('SELECT name, position, archived_at FROM projects WHERE id = ?')
        .bind(localId)
        .first(),
    ).toEqual(before);
    await setRole('editor');
  });

  it('creates concurrent projects without duplicate positions', async () => {
    const responses = await Promise.all([
      request(`/api/workspaces/${workspaceId}/projects`, editorCookie, 'POST', { name: 'Concurrent A' }),
      request(`/api/workspaces/${workspaceId}/projects`, editorCookie, 'POST', { name: 'Concurrent B' }),
    ]);
    expect(responses.map((response) => response.status)).toEqual([201, 201]);
    const rows = (
      await env.DB.prepare(
        'SELECT position FROM projects WHERE workspace_id = ? AND archived_at IS NULL',
      )
        .bind(workspaceId)
        .all<{ position: string }>()
    ).results;
    expect(new Set(rows.map((row) => row.position)).size).toBe(rows.length);
  });

  it('rejects a move between duplicate legacy positions without changing the order', async () => {
    const list = (await (await request(`/api/workspaces/${workspaceId}/projects`, ownerCookie)).json()) as Array<{
      id: string;
      position: string;
    }>;
    expect(list.length).toBeGreaterThanOrEqual(3);
    await env.DB.prepare('UPDATE projects SET position = ? WHERE id = ?')
      .bind(list[0]!.position, list[1]!.id)
      .run();
    const before = (await (await request(`/api/workspaces/${workspaceId}/projects`, ownerCookie)).json()) as Array<{
      id: string;
      position: string;
    }>;
    expect(before[0]!.position).toBe(before[1]!.position);
    const response = await request(`/api/workspaces/${workspaceId}/projects/${before[2]!.id}/move`, ownerCookie, 'POST', {
      afterId: before[0]!.id,
    });
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ error: { code: 'project_order_changed' } });
    expect(await (await request(`/api/workspaces/${workspaceId}/projects`, ownerCookie)).json()).toEqual(before);
  });
});

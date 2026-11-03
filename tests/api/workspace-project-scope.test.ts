import { env } from 'cloudflare:test';
import { beforeAll, describe, expect, it } from 'vitest';
import { createWorkerApp } from '../../src/worker';
import { createDb } from '../../src/core/adapters/db/d1/client';
import * as schema from '../../src/core/adapters/db/d1/schema';
import { getAccountWorkspaceScope } from './account-scope';

const app = createWorkerApp(env);
const db = createDb(env.DB);

describe('explicit workspace project list', () => {
  let ownerCookie = '';
  let viewerCookie = '';
  let workspaceId = '';
  let viewerId = '';
  let liveProjectId = '';
  let archivedProjectId = '';
  const foreignWorkspaceId = 'foreign-workspace-for-project-list';
  const foreignProjectId = 'foreign-project-for-project-list';

  const request = (path: string, cookie = '', init: RequestInit = {}) => {
    const headers = new Headers(init.headers);
    if (cookie) headers.set('Cookie', cookie);
    if (init.body) headers.set('Content-Type', 'application/json');
    return app.request(`http://localhost${path}`, { ...init, headers }, env);
  };
  const post = (path: string, body: unknown, cookie = '') =>
    request(path, cookie, { method: 'POST', body: JSON.stringify(body) });
  const projects = (wid: string, cookie = '') => request(`/api/workspaces/${wid}/projects`, cookie);

  beforeAll(async () => {
    const owner = await post('/api/auth/sign-up/email', {
      name: 'Project list owner',
      email: 'workspace-project-owner@example.test',
      password: 'password123',
      bootstrapToken: env.BOOTSTRAP_TOKEN || 'test-bootstrap-token',
    });
    expect(owner.status).toBe(200);
    ownerCookie = owner.headers.get('set-cookie')!;
    const ownerScope = await getAccountWorkspaceScope(async (path) => request(path, ownerCookie));
    workspaceId = ownerScope.workspaceId;
    liveProjectId = ownerScope.projectId;

    const invite = await post(
      `/api/workspaces/${workspaceId}/invites`,
      { email: 'workspace-project-viewer@example.test', role: 'viewer' },
      ownerCookie,
    );
    expect(invite.status).toBe(200);
    const { token } = (await invite.json()) as { token: string };
    const viewer = await post('/api/auth/sign-up/email', {
      name: 'Project list viewer',
      email: 'workspace-project-viewer@example.test',
      password: 'password123',
      inviteToken: token,
    });
    expect(viewer.status).toBe(200);
    viewerCookie = viewer.headers.get('set-cookie')!;
    viewerId = (await getAccountWorkspaceScope(async (path) => request(path, viewerCookie))).userId;

    const scopedProjects = `/api/workspaces/${workspaceId}/projects`;
    const created = await post(scopedProjects, { name: 'Archived project' }, ownerCookie);
    expect(created.status).toBe(201);
    archivedProjectId = ((await created.json()) as { id: string }).id;
    const archive = await request(`${scopedProjects}/${archivedProjectId}`, ownerCookie, {
      method: 'PATCH',
      body: JSON.stringify({ archived: true }),
    });
    expect(archive.status).toBe(200);

    const now = Date.now();
    await db.insert(schema.workspaces).values({
      id: foreignWorkspaceId,
      name: 'Foreign workspace',
      createdBy: ownerScope.userId,
      createdAt: now,
    });
    await db.insert(schema.projects).values({
      id: foreignProjectId,
      workspaceId: foreignWorkspaceId,
      name: 'Foreign project',
      position: 'a0',
      createdAt: now,
      updatedAt: now,
    });
  });

  it('requires authentication and conceals foreign and nonexistent workspaces', async () => {
    expect((await projects(workspaceId)).status).toBe(401);
    for (const cookie of [ownerCookie, viewerCookie]) {
      const foreign = await projects(foreignWorkspaceId, cookie);
      const missing = await projects('missing-workspace', cookie);
      expect(foreign.status).toBe(404);
      expect(missing.status).toBe(404);
      expect(await foreign.json()).toEqual(await missing.json());
    }
  });

  it('returns only live projects in the requested workspace to both owner and viewer', async () => {
    for (const cookie of [ownerCookie, viewerCookie]) {
      const response = await projects(workspaceId, cookie);
      expect(response.status).toBe(200);
      expect(response.headers.get('cache-control')).toBe('private, no-store');
      const body = (await response.json()) as Array<{ id: string; workspaceId: string }>;
      expect(body.map((project) => project.id)).toEqual([liveProjectId]);
      expect(body.every((project) => project.workspaceId === workspaceId)).toBe(true);
      expect(body.map((project) => project.id)).not.toContain(archivedProjectId);
      expect(body.map((project) => project.id)).not.toContain(foreignProjectId);
    }
  });

  it('denies a revoked member immediately without destroying their account session', async () => {
    const removed = await request(`/api/workspaces/${workspaceId}/members/${viewerId}`, ownerCookie, { method: 'DELETE' });
    expect(removed.status).toBe(200);
    expect((await projects(workspaceId, viewerCookie)).status).toBe(404);
    const session = await request('/api/auth/get-session', viewerCookie);
    expect(session.status).toBe(200);
    expect((await session.json()) as { user: { id: string } }).toMatchObject({
      user: { id: viewerId },
    });
    expect((await projects(workspaceId, ownerCookie)).status).toBe(200);
  });
});

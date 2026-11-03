import { env } from 'cloudflare:test';
import { beforeAll, describe, expect, it } from 'vitest';
import { createWorkerApp } from '../../src/worker';
import type { ReferencePreview } from '../../src/shared/references';
import { getAccountWorkspaceScope } from './account-scope';

const app = createWorkerApp(env);

describe('project-scoped reference previews', () => {
  let cookie = '',
    workspaceId = '',
    projectId = '',
    foreignProject = '';
  let noteId = '',
    foreignNote = '',
    boardId = '',
    cardId = '';
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
  const preview = (kind: string, id: string, source = projectId) =>
    request(`/api/workspaces/${workspaceId}/projects/${source}/references/${kind}/${id}`);

  beforeAll(async () => {
    const signup = await post('/api/auth/sign-up/email', {
      email: 'reference-preview@example.com',
      password: 'password123',
      name: 'Reference owner',
      bootstrapToken: env.BOOTSTRAP_TOKEN || 'test-bootstrap-token',
    });
    expect(signup.status).toBe(200);
    cookie = signup.headers.get('set-cookie')!;
    const scope = await getAccountWorkspaceScope(request);
    workspaceId = scope.workspaceId;
    projectId = scope.projectId;
    foreignProject = (
      await json<{ id: string }>(await post(`/api/workspaces/${workspaceId}/projects`, { name: 'Other project' }), 201)
    ).id;
    noteId = (
      await json<{ id: string }>(
        await post(`/api/workspaces/${workspaceId}/projects/${projectId}/notepads`, { title: 'Local note' }),
        201,
      )
    ).id;
    foreignNote = (
      await json<{ id: string }>(
        await post(`/api/workspaces/${workspaceId}/projects/${foreignProject}/notepads`, { title: 'Other note' }),
        201,
      )
    ).id;
    boardId = (
      await json<{ id: string }>(
        await post(`/api/workspaces/${workspaceId}/projects/${projectId}/boards`, { name: 'Local board' }),
        201,
      )
    ).id;
    const board = await json<{ columns: Array<{ id: string }> }>(
      await request(`/api/workspaces/${workspaceId}/projects/${projectId}/boards/${boardId}`),
      200,
    );
    cardId = (
      await json<{ cardId: string }>(
        await post(`/api/workspaces/${workspaceId}/projects/${projectId}/columns/${board.columns[0]!.id}/cards`, { title: 'Local card' }),
        201,
      )
    ).cardId;
  });

  it('returns minimal live previews for all content kinds without document bodies', async () => {
    for (const [kind, id, title] of [
      ['notepad', noteId, 'Local note'],
      ['board', boardId, 'Local board'],
      ['card', cardId, 'Local card'],
    ]) {
      const response = await preview(kind!, id!);
      expect(response.headers.get('cache-control')).toBe('private, no-store');
      const body = await json<ReferencePreview>(response, 200);
      expect(body).toMatchObject({ kind, id, title, projectId, workspaceId });
      expect(body).not.toHaveProperty('content');
      expect(body).not.toHaveProperty('assignees');
      if (kind === 'card') expect(body.boardId).toBe(boardId);
    }
  });

  it('does not resolve another project even when the account can access it directly', async () => {
    expect((await request(`/api/workspaces/${workspaceId}/projects/${projectId}/notepads/${foreignNote}`)).status).toBe(404);
    expect((await request(`/api/workspaces/${workspaceId}/projects/${projectId}/notepads/${noteId}`)).status).toBe(200);
    expect((await preview('notepad', foreignNote)).status).toBe(404);
    expect((await preview('notepad', noteId, foreignProject)).status).toBe(404);
    const allowed = await json<ReferencePreview>(
      await preview('notepad', foreignNote, foreignProject),
      200,
    );
    expect(allowed.projectId).toBe(foreignProject);
  });

  it('requires authentication and valid reference kinds', async () => {
    expect(
      (
        await app.request(
          `http://localhost/api/workspaces/${workspaceId}/projects/${projectId}/references/notepad/${noteId}`,
          {},
          env,
        )
      ).status,
    ).toBe(401);
    expect((await preview('user', noteId)).status).toBe(400);
    expect((await preview('notepad', 'missing')).status).toBe(404);
  });

  it('requires project scope for summaries and excludes IDs from another project', async () => {
    expect(await json<unknown[]>(
      await request(`/api/workspaces/${workspaceId}/projects/${projectId}/cards/summary`),
      200,
    )).toEqual([]);
    const foreign = await json<unknown[]>(
      await request(`/api/workspaces/${workspaceId}/projects/${foreignProject}/cards/summary?ids=${cardId}`),
      200,
    );
    expect(foreign).toEqual([]);
    const local = await json<Array<{ id: string }>>(
      await request(`/api/workspaces/${workspaceId}/projects/${projectId}/cards/summary?ids=${cardId}`),
      200,
    );
    expect(local.map((item) => item.id)).toEqual([cardId]);
  });

  it('stops resolving deleted targets even after an earlier successful preview', async () => {
    expect((await preview('notepad', noteId)).status).toBe(200);
    expect((await request(`/api/workspaces/${workspaceId}/projects/${projectId}/notepads/${noteId}`, { method: 'DELETE' })).status).toBe(200);
    expect((await preview('notepad', noteId)).status).toBe(404);
  });
});

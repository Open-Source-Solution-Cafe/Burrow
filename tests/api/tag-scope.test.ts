import { env } from 'cloudflare:test';
import { beforeAll, describe, expect, it } from 'vitest';
import { createWorkerApp } from '../../src/worker';
import { createDb } from '../../src/core/adapters/db/d1/client';
import * as schema from '../../src/core/adapters/db/d1/schema';
import { getAccountWorkspaceScope } from './account-scope';

const app = createWorkerApp(env);
const db = createDb(env.DB);

describe('project-local tag reads', () => {
  let cookie = '';
  let workspaceId = '';
  let projectId = '';
  let noteId = '';
  let cardId = '';
  let boardId = '';
  let localTag = '';

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

  beforeAll(async () => {
    const signup = await post('/api/auth/sign-up/email', {
      email: 'tag-scope@example.com',
      password: 'password123',
      name: 'Tag scope owner',
      bootstrapToken: env.BOOTSTRAP_TOKEN || 'test-bootstrap-token',
    });
    expect(signup.status).toBe(200);
    cookie = signup.headers.get('set-cookie')!;
    const scope = await getAccountWorkspaceScope(request);
    workspaceId = scope.workspaceId;
    projectId = scope.projectId;
    const foreignProject = (
      await json<{ id: string }>(await post(`/api/workspaces/${workspaceId}/projects`, { name: 'Other project' }), 201)
    ).id;
    localTag = (
      await json<{ id: string }>(
        await post(`/api/workspaces/${workspaceId}/projects/${projectId}/tags`, { name: 'Local tag' }),
        201,
      )
    ).id;
    const foreignTag = (
      await json<{ id: string }>(
        await post(`/api/workspaces/${workspaceId}/projects/${foreignProject}/tags`, { name: 'Foreign tag' }),
        201,
      )
    ).id;
    noteId = (
      await json<{ id: string }>(
        await post(`/api/workspaces/${workspaceId}/projects/${projectId}/notepads`, { title: 'Local note' }),
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
    const card = await json<{ cardId: string; notepadId: string }>(
      await post(`/api/workspaces/${workspaceId}/projects/${projectId}/columns/${board.columns[0]!.id}/cards`, {
        title: 'Local card',
        assigneeIds: [scope.userId],
        tagIds: [localTag],
      }),
      201,
    );
    cardId = card.cardId;
    // Simulate legacy corrupt associations that predate project validation.
    await env.DB.prepare('DROP TRIGGER notepad_tags_scope_insert_guard').run();
    try {
      await db.insert(schema.notepadTags).values([
        { notepadId: noteId, tagId: localTag },
        { notepadId: noteId, tagId: foreignTag },
        { notepadId: card.notepadId, tagId: foreignTag },
      ]);
    } finally {
      await env.DB.prepare(`CREATE TRIGGER notepad_tags_scope_insert_guard
        BEFORE INSERT ON notepad_tags
        WHEN NOT EXISTS (
          SELECT 1 FROM notepads n JOIN tags t ON t.id = NEW.tag_id
          WHERE n.id = NEW.notepad_id AND n.project_id = t.project_id
        )
        BEGIN SELECT RAISE(ABORT, 'scope_write_conflict'); END`).run();
    }
  });

  it('returns only the note project tags', async () => {
    const note = await json<{ tags: Array<{ id: string }> }>(
      await request(`/api/workspaces/${workspaceId}/projects/${projectId}/notepads/${noteId}`),
      200,
    );
    expect(note.tags.map((tag) => tag.id)).toEqual([localTag]);
  });

  it('returns only the card project tags in detail, board and task views', async () => {
    const card = await json<{ tags: Array<{ id: string }> }>(
      await request(`/api/workspaces/${workspaceId}/projects/${projectId}/cards/${cardId}`),
      200,
    );
    expect(card.tags.map((tag) => tag.id)).toEqual([localTag]);

    const board = await json<{
      columns: Array<{ cards: Array<{ id: string; tags: Array<{ id: string }> }> }>;
    }>(await request(`/api/workspaces/${workspaceId}/projects/${projectId}/boards/${boardId}`), 200);
    const boardCard = board.columns
      .flatMap((column) => column.cards)
      .find((item) => item.id === cardId);
    expect(boardCard?.tags.map((tag) => tag.id)).toEqual([localTag]);

    const tasks = await json<Array<{ id: string; tags: Array<{ id: string }> }>>(
      await request(`/api/workspaces/${workspaceId}/my-tasks`),
      200,
    );
    expect(tasks.find((task) => task.id === cardId)?.tags.map((tag) => tag.id)).toEqual([localTag]);
  });
});

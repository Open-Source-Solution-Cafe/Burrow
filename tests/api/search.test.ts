import { env } from 'cloudflare:test';
import { beforeAll, describe, expect, it } from 'vitest';
import { createWorkerApp } from '../../src/worker/index';
import type { SearchHit } from '../../src/core/adapters/search';
import { getAccountWorkspaceScope } from './account-scope';

const app = createWorkerApp(env);

describe('GET /api/workspaces/:wid/search endpoint contract', () => {
  const bootstrapToken = env.BOOTSTRAP_TOKEN || 'test-bootstrap-token';
  let cookie = '';
  let workspaceId = '';
  let projectId = '';
  let boardId = '';
  let cardId = '';
  let cardNotepadId = '';
  let plainNotepadId = '';
  let tagId = '';

  beforeAll(async () => {
    // 1. Sign up user
    const userRes = await app.request(
      'http://localhost/api/auth/sign-up/email',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          email: 'search-endpoint-test@example.com',
          password: 'password123',
          name: 'Search Tester',
          bootstrapToken,
        }),
      },
      env,
    );
    expect(userRes.status).toBe(200);
    cookie = userRes.headers.get('set-cookie')!;

    const scope = await getAccountWorkspaceScope(async (path) => app.request(
      `http://localhost${path}`,
      { headers: { Cookie: cookie } },
      env,
    ));
    workspaceId = scope.workspaceId;
    projectId = scope.projectId;
    expect(projectId).toBeDefined();

    // 2. Create Tag "#bug"
    const tagRes = await app.request(
      `http://localhost/api/workspaces/${workspaceId}/projects/${projectId}/tags`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Cookie: cookie },
        body: JSON.stringify({ name: 'bug', color: '#ef4444' }),
      },
      env,
    );
    expect(tagRes.status).toBe(201);
    const tag = (await tagRes.json()) as { id: string; name: string };
    tagId = tag.id;

    // 3. Create Board and retrieve first column
    const boardRes = await app.request(
      `http://localhost/api/workspaces/${workspaceId}/projects/${projectId}/boards`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Cookie: cookie },
        body: JSON.stringify({ name: 'Sprint Board' }),
      },
      env,
    );
    expect(boardRes.status).toBe(201);
    const b = (await boardRes.json()) as { id: string };
    boardId = b.id;

    const boardDetailRes = await app.request(
      `http://localhost/api/workspaces/${workspaceId}/projects/${projectId}/boards/${boardId}`,
      { headers: { Cookie: cookie } },
      env,
    );
    expect(boardDetailRes.status).toBe(200);
    const boardDetail = (await boardDetailRes.json()) as {
      columns: Array<{ id: string; name: string }>;
    };
    const colId = boardDetail.columns[0]!.id;

    // 4. Create Card with #bug tag
    const cardRes = await app.request(
      `http://localhost/api/workspaces/${workspaceId}/projects/${projectId}/columns/${colId}/cards`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Cookie: cookie },
        body: JSON.stringify({
          title: 'Crash on login page',
          priority: 'high',
          tagIds: [tagId],
        }),
      },
      env,
    );
    expect(cardRes.status).toBe(201);
    const cData = (await cardRes.json()) as { cardId: string; notepadId: string };
    cardId = cData.cardId;
    cardNotepadId = cData.notepadId;

    // 5. Create Plain Notepad tagged with #bug
    const npRes = await app.request(
      `http://localhost/api/workspaces/${workspaceId}/projects/${projectId}/notepads`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Cookie: cookie },
        body: JSON.stringify({ title: 'Bug triage meeting notes' }),
      },
      env,
    );
    expect(npRes.status).toBe(201);
    const np = (await npRes.json()) as { id: string };
    plainNotepadId = np.id;

    const tagAttachRes = await app.request(
      `http://localhost/api/workspaces/${workspaceId}/projects/${projectId}/notepads/${plainNotepadId}/tags`,
      {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', Cookie: cookie },
        body: JSON.stringify({ tagIds: [tagId] }),
      },
      env,
    );
    expect(tagAttachRes.status).toBe(200);
  });

  it('rejects project search without a project ID instead of widening search', async () => {
      const response = await app.request(
        `http://localhost/api/workspaces/${workspaceId}/search?q=Crash&scope=project`,
        {
          headers: { Cookie: cookie },
        },
        env,
      );
      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({
        error: { code: 'project_required', message: 'Project search requires a project ID' },
      });
  });

  it('allows workspace-wide search only when requested explicitly', async () => {
    const response = await app.request(
      `http://localhost/api/workspaces/${workspaceId}/search?q=Crash&scope=all`,
      {
        headers: { Cookie: cookie },
      },
      env,
    );
    expect(response.status).toBe(200);
    expect(((await response.json()) as SearchHit[]).map((hit) => hit.id)).toContain(cardNotepadId);
  });

  it('searching #bug finds both notepads and cards tagged #bug', async () => {
    const res = await app.request(
      `http://localhost/api/workspaces/${workspaceId}/search?q=${encodeURIComponent('#bug')}&projectId=${projectId}&scope=project`,
      { headers: { Cookie: cookie } },
      env,
    );
    expect(res.status).toBe(200);
    const hits = (await res.json()) as SearchHit[];

    const cardHit = hits.find((h) => h.id === cardNotepadId);
    expect(cardHit).toBeDefined();
    expect(cardHit?.title).toBe('Crash on login page');
    expect(cardHit?.kind).toBe('card');

    const notepadHit = hits.find((h) => h.id === plainNotepadId);
    expect(notepadHit).toBeDefined();
    expect(notepadHit?.title).toBe('Bug triage meeting notes');
    expect(notepadHit?.kind).toBe('notepad');
  });

  it('card search results include cardId and boardId', async () => {
    // Search by card title
    const res = await app.request(
      `http://localhost/api/workspaces/${workspaceId}/search?q=Crash&projectId=${projectId}&scope=project`,
      { headers: { Cookie: cookie } },
      env,
    );
    expect(res.status).toBe(200);
    const hits = (await res.json()) as SearchHit[];

    const cardHit = hits.find((h) => h.id === cardNotepadId);
    expect(cardHit).toBeDefined();
    expect(cardHit?.kind).toBe('card');
    expect(cardHit?.cardId).toBe(cardId);
    expect(cardHit?.boardId).toBe(boardId);

    // Regular notepad should not have cardId or boardId
    const npRes = await app.request(
      `http://localhost/api/workspaces/${workspaceId}/search?q=triage&projectId=${projectId}&scope=project`,
      { headers: { Cookie: cookie } },
      env,
    );
    expect(npRes.status).toBe(200);
    const npHits = (await npRes.json()) as SearchHit[];
    const npHit = npHits.find((h) => h.id === plainNotepadId);
    expect(npHit).toBeDefined();
    expect(npHit?.kind).toBe('notepad');
    expect(npHit?.cardId).toBeUndefined();
    expect(npHit?.boardId).toBeUndefined();
  });

  it('indexes inline tag labels without creating reference links or notifications', async () => {
    const created = await app.request(
      `http://localhost/api/workspaces/${workspaceId}/projects/${projectId}/notepads`,
      {
        method: 'POST',
        headers: { Cookie: cookie, 'Content-Type': 'application/json' },
        body: JSON.stringify({ title: 'Inline tag document' }),
      },
      env,
    );
    expect(created.status).toBe(201);
    const { id } = (await created.json()) as { id: string };
    const content = JSON.stringify([
      {
        type: 'paragraph',
        content: [{ type: 'mention', props: { kind: 'tag', id: tagId, label: 'axolotlindex' } }],
      },
    ]);
    const saved = await app.request(
      `http://localhost/api/workspaces/${workspaceId}/projects/${projectId}/notepads/${id}/content`,
      {
        method: 'PUT',
        headers: { Cookie: cookie, 'Content-Type': 'application/json' },
        body: JSON.stringify({ content, baseVersion: 1 }),
      },
      env,
    );
    expect(saved.status).toBe(200);

    const search = await app.request(
      `http://localhost/api/workspaces/${workspaceId}/search?q=axolotlindex&projectId=${projectId}&scope=project`,
      { headers: { Cookie: cookie } },
      env,
    );
    expect(search.status).toBe(200);
    expect(((await search.json()) as SearchHit[]).map((hit) => hit.id)).toContain(id);
    for (const table of ['notepad_links', 'notifications']) {
      const column = table === 'notepad_links' ? 'source_id' : 'notepad_id';
      const row = await env.DB.prepare(`SELECT count(*) AS n FROM ${table} WHERE ${column} = ?`)
        .bind(id)
        .first<{ n: number }>();
      expect(row?.n).toBe(0);
    }
  });
});

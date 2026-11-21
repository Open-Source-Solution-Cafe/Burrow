import { describe, it, expect, vi } from 'vitest';
import { Hono } from 'hono';
import { createShareManagementRoutes, createPublicShareViewerRoutes } from './public-shares';

describe('Opt-In Public Read-Only Share Links (Milestone 4)', () => {
  it('enforces feature flag, strips member info & comments, scopes media proxy, and revokes cleanly', async () => {
    let storedShare: any = null;
    let flagEnabled = false;

    const notepadContent = JSON.stringify([
      {
        type: 'paragraph',
        content: [
          { type: 'mention', props: { kind: 'user', id: 'user-secret', label: 'Alice Secret' } },
          { type: 'text', text: ' hello' },
        ],
      },
      {
        type: 'image',
        props: {
          url: 'https://example.com/api/workspaces/ws-1/projects/proj-1/files/ws-1%2Fproj-1%2Fallowed.png',
        },
      },
    ]);

    const mockRepos = {
      workspaces: {
        getFeatureFlags: vi.fn(async () => ({ publicSharing: flagEnabled })),
      },
      members: {
        findByUserId: vi.fn(async () => ({ workspaceId: 'ws-1', userId: 'user-1', role: 'editor' })),
      },
      projects: {
        findByIdAndWorkspace: vi.fn(async () => ({ id: 'proj-1', workspaceId: 'ws-1', archivedAt: null })),
      },
      notepads: {
        findByIdInScope: vi.fn(async (_scope: any, id: string) =>
          id === 'np-1'
            ? {
                id: 'np-1',
                workspaceId: 'ws-1',
                projectId: 'proj-1',
                kind: 'notepad',
                title: 'Public Doc',
                icon: '📄',
                coverKey: null,
                content: notepadContent,
                deletedAt: null,
                updatedAt: 1000,
              }
            : null,
        ),
        getContent: vi.fn(async () => ({ content: notepadContent })),
        listTagIds: vi.fn(async () => ['tag-1']),
      },
      tags: {
        listByProject: vi.fn(async () => [{ id: 'tag-1', name: 'roadmap', color: '#6366f1' }]),
      },
      boards: {
        getBoardWithDetails: vi.fn(async () => ({
          id: 'board-1',
          name: 'Public Roadmap',
          icon: '📋',
          deletedAt: null,
          updatedAt: 2000,
          columns: [
            {
              id: 'col-1',
              name: 'Planned',
              color: null,
              wipLimit: null,
              cards: [
                {
                  id: 'card-1',
                  title: 'Ship v1',
                  priority: 'high',
                  dueDate: null,
                  tags: [{ id: 'tag-1', name: 'roadmap' }],
                  assignees: [{ userId: 'user-secret', name: 'Alice Secret' }],
                  totalSubtasks: 1,
                  completedSubtasks: 1,
                },
              ],
            },
          ],
        })),
        findByIdInScope: vi.fn(async () => ({ id: 'board-1', deletedAt: null })),
      },
      cards: {
        getCardWithDetails: vi.fn(async () => ({
          content: '[]',
          subtasks: [{ id: 'sub-1', title: 'Task 1', completed: true }],
          comments: [{ id: 'c1', content: 'Internal secret comment', userId: 'user-secret' }],
        })),
      },
      projectFiles: {
        findByProjectAndKey: vi.fn(async (_pid: string, key: string) =>
          key === 'ws-1/proj-1/allowed.png' || key === 'ws-1/proj-1/secret.png'
            ? { storageKey: key, contentType: 'image/png' }
            : null,
        ),
      },
      publicShares: {
        findByTarget: vi.fn(async () => storedShare),
        findByToken: vi.fn(async (tok: string) => (storedShare?.token === tok ? storedShare : null)),
        upsert: vi.fn(async (s: any) => {
          storedShare = s;
          return s;
        }),
        revokeByTarget: vi.fn(async () => {
          if (!storedShare) return false;
          storedShare = { ...storedShare, enabled: false };
          return true;
        }),
      },
    } as any;

    const storage = {
      get: vi.fn(async (key: string) => ({
        body: new Uint8Array([1, 2, 3]),
        contentType: 'image/png',
        key,
      })),
    } as any;

    const app = new Hono<any>();
    app.use('/api/workspaces/*', async (c, next) => {
      c.set('identity', { userId: 'user-1' });
      await next();
    });
    app.route('/api', createShareManagementRoutes({ repositories: mockRepos }));
    app.route('/api/public/shares', createPublicShareViewerRoutes({ repositories: mockRepos, storage }));
    app.onError((err: any, c) =>
      c.json({ error: { code: err.code || 'err', message: err.message } }, err.status || 500),
    );

    // 1. Blocked when publicSharing flag is dormant
    const dormant = await app.request('/api/workspaces/ws-1/projects/proj-1/shares/notepad/np-1', {
      method: 'POST',
    });
    expect(dormant.status).toBe(404);

    // 2. Enable flag and publish notepad
    flagEnabled = true;
    const pubRes = await app.request('/api/workspaces/ws-1/projects/proj-1/shares/notepad/np-1', {
      method: 'POST',
    });
    expect(pubRes.status).toBe(201);
    const { token } = (await pubRes.json()) as any;

    // 3. Public GET strips user mention PII, rewrites media URL, sets X-Robots-Tag
    const viewRes = await app.request(`/api/public/shares/${token}`);
    expect(viewRes.status).toBe(200);
    expect(viewRes.headers.get('X-Robots-Tag')).toBe('noindex, nofollow');
    const viewBody = (await viewRes.json()) as any;
    expect(viewBody.content).not.toContain('Alice Secret');
    expect(viewBody.content).not.toContain('user-secret');
    expect(viewBody.content).toContain(`/api/public/shares/${token}/files/`);

    // 4. Scoped media proxy serves referenced file and blocks unreferenced project file
    const allowedMedia = await app.request(
      `/api/public/shares/${token}/files/${encodeURIComponent('ws-1/proj-1/allowed.png')}`,
    );
    expect(allowedMedia.status).toBe(200);

    const unreferencedMedia = await app.request(
      `/api/public/shares/${token}/files/${encodeURIComponent('ws-1/proj-1/secret.png')}`,
    );
    expect(unreferencedMedia.status).toBe(404);

    // 5. Public board hides assignees and comments
    storedShare = {
      id: 's2',
      token: 'board-tok',
      workspaceId: 'ws-1',
      projectId: 'proj-1',
      targetType: 'board',
      targetId: 'board-1',
      enabled: true,
      createdBy: 'user-1',
      createdAt: 1000,
      expiresAt: null,
    };
    const boardRes = await app.request('/api/public/shares/board-tok');
    expect(boardRes.status).toBe(200);
    const boardText = await boardRes.text();
    expect(boardText).not.toContain('Alice Secret');
    expect(boardText).not.toContain('Internal secret comment');

    // 6. Revoke -> immediate 404, re-enable -> preserves exact same token; regenerate -> new token
    const delRes = await app.request('/api/workspaces/ws-1/projects/proj-1/shares/notepad/np-1', {
      method: 'DELETE',
    });
    expect(delRes.status).toBe(200);
    const afterRevoke = await app.request(`/api/public/shares/board-tok`);
    expect(afterRevoke.status).toBe(404);

    // Re-enable notepad share and verify token preservation
    storedShare = {
      id: 's1',
      token,
      workspaceId: 'ws-1',
      projectId: 'proj-1',
      targetType: 'notepad',
      targetId: 'np-1',
      enabled: false,
      createdBy: 'user-1',
      createdAt: 1000,
      expiresAt: null,
    };
    const reEnableRes = await app.request('/api/workspaces/ws-1/projects/proj-1/shares/notepad/np-1', {
      method: 'POST',
    });
    expect(reEnableRes.status).toBe(201);
    const reEnabledBody = (await reEnableRes.json()) as any;
    expect(reEnabledBody.token).toBe(token);
    expect((await app.request(`/api/public/shares/${token}`)).status).toBe(200);

    // Explicit regenerate rotates to a new token
    const regenRes = await app.request('/api/workspaces/ws-1/projects/proj-1/shares/notepad/np-1', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ regenerate: true }),
    });
    expect(regenRes.status).toBe(201);
    const regenBody = (await regenRes.json()) as any;
    expect(regenBody.token).not.toBe(token);
    expect((await app.request(`/api/public/shares/${token}`)).status).toBe(404);
    expect((await app.request(`/api/public/shares/${regenBody.token}`)).status).toBe(200);
  });
});

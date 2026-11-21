import { describe, it, expect, vi } from 'vitest';
import { Hono } from 'hono';
import { createWorkspaceExportRoutes } from './workspace-export';

describe('Workspace Export, GDPR Delete & Migration Routes (Milestone 2)', () => {
  it('enforces feature flags, owner-only full export, and GDPR workspace deletion', async () => {
    const mockRepos = {
      workspaces: {
        getFeatureFlags: vi.fn(async () => ({ workspaceExport: false })),
        findById: vi.fn(async () => ({ id: 'ws-1', name: 'Acme', createdAt: 1 })),
        deleteGuarded: vi.fn(async (_wid: string, _uid: string, confirm: string) =>
          confirm === 'Acme' ? ['ws-1/proj-1/logo.png'] : null,
        ),
      },
      members: {
        findByUserId: vi.fn(async (_wid: string, uid: string) =>
          uid === 'owner-1'
            ? { workspaceId: 'ws-1', userId: 'owner-1', role: 'owner' }
            : { workspaceId: 'ws-1', userId: 'editor-1', role: 'editor' },
        ),
      },
      projects: {
        listByWorkspace: vi.fn(async () => [
          { id: 'proj-1', workspaceId: 'ws-1', name: 'Core', icon: null, color: null },
        ]),
      },
      tags: { listByProject: vi.fn(async () => []) },
      notepads: {
        listByProject: vi.fn(async () => []),
        getContent: vi.fn(async () => null),
        listTagIds: vi.fn(async () => []),
        countByCoverKey: vi.fn(async () => 0),
      },
      boards: { listByProject: vi.fn(async () => []), getBoardWithDetails: vi.fn(async () => null) },
      cards: { getCardWithDetails: vi.fn(async () => null) },
      projectFiles: {
        listStorageKeysByProject: vi.fn(async () => []),
        findByProjectAndKey: vi.fn(async () => null),
        countByStorageKey: vi.fn(async () => 0),
      },
    } as any;

    const storage = { delete: vi.fn(async () => {}) } as any;
    const app = new Hono<any>();
    app.use('*', async (c, next) => {
      c.set('identity', { userId: c.req.header('x-user') || 'owner-1' });
      await next();
    });
    app.route('/api/workspaces', createWorkspaceExportRoutes({ repositories: mockRepos, storage }));
    app.onError((err: any, c) =>
      c.json({ error: { code: err.code || 'err', message: err.message } }, err.status || 500),
    );

    // 1. Export blocked when workspaceExport flag is dormant (false)
    const dormantRes = await app.request('/api/workspaces/ws-1/export', {
      headers: { 'x-user': 'owner-1' },
    });
    expect(dormantRes.status).toBe(404);

    // 2. Enable flag -> editor blocked from both full-workspace and project exports (403); owner succeeds (200)
    mockRepos.workspaces.getFeatureFlags.mockResolvedValue({ workspaceExport: true });
    const editorRes = await app.request('/api/workspaces/ws-1/export', {
      headers: { 'x-user': 'editor-1' },
    });
    expect(editorRes.status).toBe(403);

    const editorProjectRes = await app.request('/api/workspaces/ws-1/export?projectId=proj-1', {
      headers: { 'x-user': 'editor-1' },
    });
    expect(editorProjectRes.status).toBe(403);

    const ownerRes = await app.request('/api/workspaces/ws-1/export', {
      headers: { 'x-user': 'owner-1' },
    });
    expect(ownerRes.status).toBe(200);
    const manifest = (await ownerRes.json()) as any;
    expect(manifest.schemaVersion).toBe('burrow-export-v1');
    expect(manifest.projects).toHaveLength(1);

    const ownerProjectRes = await app.request('/api/workspaces/ws-1/export?projectId=proj-1', {
      headers: { 'x-user': 'owner-1' },
    });
    expect(ownerProjectRes.status).toBe(200);

    // 3. GDPR workspace delete requires exact confirmation name and cleans up storage
    const badConfirm = await app.request('/api/workspaces/ws-1?confirm=Wrong', {
      method: 'DELETE',
      headers: { 'x-user': 'owner-1' },
    });
    expect(badConfirm.status).toBe(400);

    const goodDelete = await app.request('/api/workspaces/ws-1?confirm=Acme', {
      method: 'DELETE',
      headers: { 'x-user': 'owner-1' },
    });
    expect(goodDelete.status).toBe(200);
    expect(storage.delete).toHaveBeenCalledWith('ws-1/proj-1/logo.png');
  });

  it('preserves workspace featureFlags and project uploadPolicy across export and import-bundle migration', async () => {
    const storedObjects = new Map<string, string>();
    storedObjects.set(
      'ws-src/proj-src/.upload-policy.json',
      JSON.stringify({
        maxFileSizeBytes: 12 * 1024 * 1024,
        allowedMimeTypes: ['image/png', 'application/pdf'],
      }),
    );

    const updatedFlagsCalls: Array<{ wid: string; patch: Record<string, unknown> }> = [];
    const mockRepos = {
      workspaces: {
        getFeatureFlags: vi.fn(async () => ({
          workspaceExport: true,
          instanceMigration: true,
          publicSharing: true,
        })),
        updateFeatureFlags: vi.fn(async (wid: string, _uid: string, patch: Record<string, unknown>) => {
          updatedFlagsCalls.push({ wid, patch });
          return patch;
        }),
        findById: vi.fn(async () => ({ id: 'ws-src', name: 'Source WS', createdAt: 1 })),
        create: vi.fn(async (plan: any) => plan.workspace),
      },
      members: {
        findByUserId: vi.fn(async () => ({
          workspaceId: 'ws-src',
          userId: 'owner-1',
          role: 'owner',
        })),
      },
      projects: {
        listByWorkspace: vi.fn(async () => [
          { id: 'proj-src', workspaceId: 'ws-src', name: 'Design', icon: null, color: null },
        ]),
      },
      tags: { listByProject: vi.fn(async () => []) },
      notepads: {
        listByProject: vi.fn(async () => []),
        getContent: vi.fn(async () => null),
        listTagIds: vi.fn(async () => []),
        getLastRootPosition: vi.fn(async () => null),
      },
      boards: {
        listByProject: vi.fn(async () => []),
        getBoardWithDetails: vi.fn(async () => null),
      },
      cards: { getCardWithDetails: vi.fn(async () => null) },
      projectFiles: {
        listStorageKeysByProject: vi.fn(async () => []),
        findByProjectAndKey: vi.fn(async () => null),
      },
    } as any;

    const storage = {
      get: vi.fn(async (key: string) => {
        const raw = storedObjects.get(key);
        return raw ? { body: new TextEncoder().encode(raw), contentType: 'application/json' } : null;
      }),
      put: vi.fn(async (key: string, data: Uint8Array) => {
        storedObjects.set(key, new TextDecoder().decode(data));
      }),
    } as any;

    const app = new Hono<any>();
    app.use('*', async (c, next) => {
      c.set('identity', { userId: 'owner-1' });
      await next();
    });
    app.route('/api/workspaces', createWorkspaceExportRoutes({ repositories: mockRepos, storage }));
    app.onError((err: any, c) =>
      c.json({ error: { code: err.code || 'err', message: err.message } }, err.status || 500),
    );

    const exportRes = await app.request('/api/workspaces/ws-src/export');
    expect(exportRes.status).toBe(200);
    const manifest = (await exportRes.json()) as any;
    expect(manifest.workspace.featureFlags).toEqual({
      workspaceExport: true,
      instanceMigration: true,
      publicSharing: true,
    });
    expect(manifest.projects[0].uploadPolicy).toEqual({
      maxFileSizeBytes: 12 * 1024 * 1024,
      allowedMimeTypes: ['image/png', 'application/pdf'],
    });

    const importRes = await app.request('/api/workspaces/import-bundle', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        workspaceName: 'Migrated WS',
        sourceWorkspaceId: 'ws-src',
        featureFlags: manifest.workspace.featureFlags,
        projects: [
          {
            name: manifest.projects[0].name,
            icon: manifest.projects[0].icon,
            color: manifest.projects[0].color,
            data: {
              tags: [],
              notepads: [],
              boards: [],
              uploadPolicy: manifest.projects[0].uploadPolicy,
            },
          },
        ],
      }),
    });
    expect(importRes.status).toBe(201);
    const imported = (await importRes.json()) as { workspaceId: string; projects: Array<{ projectId: string }> };

    expect(updatedFlagsCalls).toEqual([
      {
        wid: imported.workspaceId,
        patch: {
          workspaceExport: true,
          instanceMigration: true,
          publicSharing: true,
        },
      },
    ]);
    const restoredPolicyKey = `${imported.workspaceId}/${imported.projects[0]!.projectId}/.upload-policy.json`;
    expect(JSON.parse(storedObjects.get(restoredPolicyKey)!)).toEqual({
      maxFileSizeBytes: 12 * 1024 * 1024,
      allowedMimeTypes: ['image/png', 'application/pdf'],
    });
  });
});

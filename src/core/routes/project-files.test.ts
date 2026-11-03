import { Hono } from 'hono';
import { describe, expect, it, vi } from 'vitest';
import type { Env } from '../app';
import { createProjectFileRoutes } from './project-files';

function createTestApp() {
  const objects = new Map<string, { body: Uint8Array; contentType: string }>();
  const key = 'workspace-a/project-a/image.png';
  const bytes = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 0]);
  const storage = {
    put: vi.fn(async (key: string, data: ArrayBuffer | Uint8Array, contentType?: string) => {
      objects.set(key, { body: new Uint8Array(data), contentType: contentType || '' });
    }),
    get: vi.fn(async (requested: string) =>
      requested === key
        ? { body: bytes, contentType: 'image/png', contentLength: bytes.length }
        : objects.get(requested) ?? null,
    ),
    delete: vi.fn(async () => {}),
    deletePrefix: vi.fn(async () => {}),
    listObjects: vi.fn(async () => []),
  };
  const projects = {
    findByIdAndWorkspace: vi.fn(async (projectId: string, workspaceId: string) =>
      workspaceId === 'workspace-a' && projectId === 'project-a'
        ? { id: projectId, workspaceId }
        : null,
    ),
    findById: vi.fn(async (projectId: string) =>
      projectId === 'project-a'
        ? { id: projectId, workspaceId: 'workspace-a' }
        : null,
    ),
  };
  const members = {
    findByUserId: vi.fn(async (workspaceId: string, userId: string) =>
      workspaceId === 'workspace-a' && userId === 'user-a'
        ? { workspaceId, userId, role: 'owner' }
        : null,
    ),
  };
  const files = {
    register: vi.fn(async () => true),
    findByProjectAndKey: vi.fn(async (projectId: string, storageKey: string) =>
      projectId === 'project-a' && storageKey === key
        ? { projectId, storageKey, contentType: 'image/png', createdBy: 'user-a', createdAt: 1 }
        : null,
    ),
    countByStorageKey: vi.fn(async () => 0),
    listProjectIdsByStorageKey: vi.fn(async (storageKey: string) =>
      storageKey === key ? ['project-a'] : [],
    ),
    listStorageKeysByProject: vi.fn(async () => [key]),
  };
  const routes = createProjectFileRoutes({
    projects: projects as never,
    members: members as never,
    files: files as never,
    storage,
  });
  const app = new Hono<Env>();
  app.use('*', async (c, next) => {
    c.set('identity', { userId: 'user-a', email: 'user-a@example.test' });
    await next();
  });
  app.onError((error, c) =>
    c.json({ error: error.message }, Number((error as { status?: number }).status ?? 500) as never),
  );
  app.route('/api', routes);
  return { app, files, key, bytes, storage, members };
}

describe('project file routes', () => {
  it('persists scoped owner upload limits and enforces types and byte limits', async () => {
    const { app } = createTestApp();
    const base = '/api/workspaces/workspace-a/projects/project-a';
    const policy = { maxFileSizeBytes: 8, allowedMimeTypes: ['text/plain'] };
    const saved = await app.request(`${base}/upload-policy`, {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(policy),
    });
    expect(saved.status).toBe(200);
    expect(await (await app.request(`${base}/upload-policy`)).json()).toEqual(policy);
    expect((await app.request('/api/workspaces/workspace-a/projects/project-b/upload-policy')).status).toBe(404);
    const upload = (name: string, type: string, text: string) => {
      const form = new FormData();
      form.append('file', new File([text], name, { type }));
      return app.request(`${base}/uploads`, { method: 'POST', body: form });
    };
    expect((await upload('note.txt', 'text/plain', '12345678')).status).toBe(200);
    expect((await upload('note.txt', 'text/plain', '123456789')).status).toBe(413);
    expect((await upload('file.pdf', 'application/pdf', '%PDF')).status).toBe(400);
    expect((await app.request(`${base}/upload-policy`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...policy, allowedMimeTypes: ['text/html'] }) })).status).toBe(400);
  });

  it('lets viewers read policy but only owners change it', async () => {
    const { app, members } = createTestApp();
    members.findByUserId.mockResolvedValue({ workspaceId: 'workspace-a', userId: 'user-a', role: 'viewer' });
    const url = '/api/workspaces/workspace-a/projects/project-a/upload-policy';
    expect((await app.request(url)).status).toBe(200);
    expect((await app.request(url, { method: 'PATCH', body: '{}' })).status).toBe(403);
  });
  it('rejects spoofed image content before writing storage', async () => {
    const { app, storage } = createTestApp();
    const form = new FormData();
    form.append('file', new File([new Uint8Array([1, 2, 3])], 'fake.png', { type: 'image/png' }));

    const response = await app.request('/api/workspaces/workspace-a/projects/project-a/uploads', {
      method: 'POST',
      body: form,
    });
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: 'File content does not match the declared image type' });
    expect(storage.put).not.toHaveBeenCalled();
  });

  it('uploads into the project registry and serves only through the scoped route', async () => {
    const { app, files, key, bytes, storage } = createTestApp();
    const form = new FormData();
    form.append('file', new File([bytes], 'image.png', { type: 'image/png' }));

    const upload = await app.request('/api/workspaces/workspace-a/projects/project-a/uploads', {
      method: 'POST',
      body: form,
    });
    expect(upload.status).toBe(200);
    const uploaded = (await upload.json()) as { key: string; url: string };
    expect(uploaded.key).toMatch(/^workspace-a\/project-a\/[\w-]+\.png$/);
    expect(uploaded.url).toContain('/api/workspaces/workspace-a/projects/project-a/files/');
    expect(files.register).toHaveBeenCalledOnce();
    expect(storage.put).toHaveBeenCalledOnce();

    const file = await app.request(
      `/api/workspaces/workspace-a/projects/project-a/files/${encodeURIComponent(key)}`,
    );
    expect(file.status).toBe(200);
    expect(file.headers.get('content-type')).toBe('image/png');
    expect(file.headers.get('cache-control')).toBe('private, no-store');
    expect(new Uint8Array(await file.arrayBuffer())).toEqual(bytes);
  });

  it('rejects mismatched workspace/project IDs and ambiguous legacy file links', async () => {
    const { app, files, key } = createTestApp();
    const mixed = await app.request(
      `/api/workspaces/workspace-a/projects/project-b/files/${encodeURIComponent(key)}`,
    );
    expect(mixed.status).toBe(404);

    const wrongWorkspace = await app.request(
      `/api/workspaces/workspace-b/projects/project-a/files/${encodeURIComponent(key)}`,
    );
    expect(wrongWorkspace.status).toBe(404);

    files.listProjectIdsByStorageKey.mockResolvedValue(['project-a', 'project-b']);
    const ambiguous = await app.request(`/api/files/${encodeURIComponent(key)}`);
    expect(ambiguous.status).toBe(404);
  });
});

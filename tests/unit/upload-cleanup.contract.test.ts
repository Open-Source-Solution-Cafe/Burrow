import { Hono } from 'hono';
import { describe, expect, it, vi } from 'vitest';
import type { Env } from '../../src/core/app';
import { createProjectFileRoutes } from '../../src/core/routes/project-files';
import type { IStorageAdapter } from '../../src/core/adapters/storage';
import type {
  IProjectFileRepository,
  IProjectRepository,
  IMemberRepository,
  ProjectFile,
} from '../../src/core/infrastructure/types';

describe('upload cleanup contract', () => {
  // A minimal valid 1x1 PNG image
  const validPngBytes = new Uint8Array([
    137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13, 73, 72, 68, 82, 0, 0, 0, 1, 0, 0, 0, 1, 8, 6,
    0, 0, 0, 31, 21, 196, 137,
  ]);

  function setupTestHarness(options: {
    registerImpl?: (file: ProjectFile) => Promise<boolean>;
    countImpl?: (storageKey: string) => Promise<number>;
  }) {
    const storageMap = new Map<string, { body: Uint8Array; contentType: string }>();
    const deleteCalls: string[] = [];
    const putCalls: Array<{ key: string; contentType: string }> = [];

    const storage: IStorageAdapter = {
      async put(key, data, contentType) {
        putCalls.push({ key, contentType: contentType || 'application/octet-stream' });
        storageMap.set(key, {
          body: data instanceof Uint8Array ? data : new Uint8Array(data as ArrayBuffer),
          contentType: contentType || 'application/octet-stream',
        });
      },
      async get(key) {
        return storageMap.get(key) ?? null;
      },
      async delete(key) {
        deleteCalls.push(key);
        storageMap.delete(key);
      },
      async deletePrefix() {},
      async listObjects() {
        return Array.from(storageMap.keys());
      },
    };

    const registeredFiles: ProjectFile[] = [];

    const files: IProjectFileRepository = {
      register: vi.fn(async (file: ProjectFile) => {
        if (options.registerImpl) {
          return options.registerImpl(file);
        }
        registeredFiles.push(file);
        return true;
      }),
      findByProjectAndKey: vi.fn(async (projectId: string, storageKey: string) => {
        const found = registeredFiles.find(
          (f) => f.projectId === projectId && f.storageKey === storageKey,
        );
        return found ?? null;
      }),
      countByStorageKey: vi.fn(async (storageKey: string) => {
        if (options.countImpl) {
          return options.countImpl(storageKey);
        }
        return registeredFiles.filter((f) => f.storageKey === storageKey).length;
      }),
      listProjectIdsByStorageKey: vi.fn(async () => []),
      listStorageKeysByProject: vi.fn(async () => []),
      listAllStorageKeys: vi.fn(async () => []),
    };

    const projects: Partial<IProjectRepository> = {
      findByIdAndWorkspace: vi.fn(async (id: string, workspaceId: string) => {
        if (id === 'proj-1' && workspaceId === 'ws-1') {
          return {
            id: 'proj-1',
            workspaceId: 'ws-1',
            name: 'Test Project',
            position: 'a0',
            icon: null,
            color: null,
            archivedAt: null,
            createdAt: 1000,
            updatedAt: 1000,
          };
        }
        return null;
      }),
    };

    const members: Partial<IMemberRepository> = {
      findByUserId: vi.fn(async (workspaceId: string, userId: string) => {
        if (workspaceId === 'ws-1' && userId === 'user-1') {
          return {
            workspaceId: 'ws-1',
            userId: 'user-1',
            role: 'editor' as const,
            joinedAt: 1000,
          };
        }
        return null;
      }),
    };

    const app = new Hono<Env>();
    app.use('*', async (c, next) => {
      c.set('identity', { userId: 'user-1', email: 'test@example.com' });
      await next();
    });
    app.onError((error, c) => {
      const status = ((error as { status?: number }).status as never) || 500;
      return c.json({ error: { message: error.message } }, status);
    });

    app.route(
      '/api',
      createProjectFileRoutes({
        projects: projects as IProjectRepository,
        members: members as IMemberRepository,
        files,
        storage,
      }),
    );

    return { app, storage, storageMap, deleteCalls, putCalls, files };
  }

  function createUploadRequest(path: string, fileBytes: Uint8Array, fileName: string) {
    const formData = new FormData();
    const file = new File([fileBytes], fileName, { type: 'image/png' });
    formData.append('file', file);
    return new Request(`http://localhost${path}`, {
      method: 'POST',
      body: formData,
    });
  }

  it('cleans up uploaded storage blob when repository throws a hard quota trigger exception', async () => {
    const quotaError = new Error('Storage quota exceeded: hard limit reached for project proj-1');
    const { app, storageMap, deleteCalls, putCalls, files } = setupTestHarness({
      registerImpl: async () => {
        throw quotaError;
      },
    });

    const res = await app.request(
      createUploadRequest('/api/workspaces/ws-1/projects/proj-1/uploads', validPngBytes, 'test.png'),
    );

    expect(res.status).toBe(500);

    // Storage put must have occurred first
    expect(putCalls.length).toBe(1);
    const uploadedKey = putCalls[0]!.key;

    // files.register must have been called
    expect(files.register).toHaveBeenCalledTimes(1);

    // Because countByStorageKey is 0, storage.delete must have been called for that key
    expect(deleteCalls).toContain(uploadedKey);

    // The blob must have been removed from storage
    expect(storageMap.has(uploadedKey)).toBe(false);
  });

  it('cleans up uploaded storage blob when file registration returns false (conflict)', async () => {
    const { app, storageMap, deleteCalls, putCalls, files } = setupTestHarness({
      registerImpl: async () => false,
    });

    const res = await app.request(
      createUploadRequest('/api/workspaces/ws-1/projects/proj-1/uploads', validPngBytes, 'duplicate.png'),
    );

    expect(res.status).toBe(409);

    // Storage put must have occurred
    expect(putCalls.length).toBe(1);
    const uploadedKey = putCalls[0]!.key;

    // files.register was called
    expect(files.register).toHaveBeenCalledTimes(1);

    // storage.delete was called to prevent orphan blob
    expect(deleteCalls).toContain(uploadedKey);
    expect(storageMap.has(uploadedKey)).toBe(false);
  });

  it('preserves the storage blob when registration succeeds', async () => {
    const { app, storageMap, deleteCalls, putCalls, files } = setupTestHarness({});

    const res = await app.request(
      createUploadRequest('/api/workspaces/ws-1/projects/proj-1/uploads', validPngBytes, 'valid.png'),
    );

    expect(res.status).toBe(200);
    expect(putCalls.length).toBe(1);
    const uploadedKey = putCalls[0]!.key;

    expect(files.register).toHaveBeenCalledTimes(1);
    expect(deleteCalls.length).toBe(0);
    expect(storageMap.has(uploadedKey)).toBe(true);
  });

  it('does NOT delete the storage blob on error if countByStorageKey > 0 (shared key registered elsewhere)', async () => {
    const { app, storageMap, deleteCalls, putCalls } = setupTestHarness({
      registerImpl: async () => {
        throw new Error('Database constraint violation');
      },
      countImpl: async () => 1,
    });

    const res = await app.request(
      createUploadRequest('/api/workspaces/ws-1/projects/proj-1/uploads', validPngBytes, 'shared.png'),
    );

    expect(res.status).toBe(500);
    expect(putCalls.length).toBe(1);
    const uploadedKey = putCalls[0]!.key;

    // storage.delete should NOT be called because another project holds this key
    expect(deleteCalls).not.toContain(uploadedKey);
    expect(storageMap.has(uploadedKey)).toBe(true);
  });
});

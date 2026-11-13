import { Hono } from 'hono';
import { describe, expect, it, vi } from 'vitest';
import type { Env } from '../../src/core/app';
import { createProjectFileRoutes } from '../../src/core/routes/project-files';
import { NotepadService } from '../../src/core/services/notepads';
import type { ILockAdapter } from '../../src/core/adapters/lock';
import type { IStorageAdapter } from '../../src/core/adapters/storage';
import type {
  IProjectFileRepository,
  IProjectRepository,
  INotepadRepository,
  ITagRepository,
  IMemberRepository,
  ProjectFile,
} from '../../src/core/infrastructure/types';
import { WORKER_MAX_UPLOAD_BYTES } from '../../src/shared/uploadPolicy';

describe('upload cleanup contract', () => {
  // A minimal valid 1x1 PNG image
  const validPngBytes = new Uint8Array([
    137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13, 73, 72, 68, 82, 0, 0, 0, 1, 0, 0, 0, 1, 8, 6,
    0, 0, 0, 31, 21, 196, 137,
  ]);

  function setupTestHarness(options: {
    registerImpl?: (file: ProjectFile) => Promise<boolean>;
    countImpl?: (storageKey: string) => Promise<number>;
    deleteStorageImpl?: (key: string) => Promise<void>;
    coverCountImpl?: (storageKey: string) => Promise<number>;
    role?: 'owner' | 'editor' | 'viewer';
    maxUploadBytes?: number;
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
        if (options.deleteStorageImpl) {
          await options.deleteStorageImpl(key);
        }
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
      unregister: vi.fn(async (projectId: string, storageKey: string) => {
        const index = registeredFiles.findIndex(
          (f) => f.projectId === projectId && f.storageKey === storageKey,
        );
        if (index < 0) return false;
        registeredFiles.splice(index, 1);
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

    const notepadsRepo: Partial<INotepadRepository> = {
      countByCoverKey: vi.fn(async (coverKey: string) =>
        options.coverCountImpl ? options.coverCountImpl(coverKey) : 0,
      ),
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
            role: options.role ?? ('editor' as const),
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
        notepads: notepadsRepo as INotepadRepository,
        storage,
        maxUploadBytes: options.maxUploadBytes,
      }),
    );

    return { app, storage, storageMap, deleteCalls, putCalls, files, notepadsRepo, registeredFiles };
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

  it('preserves DB registration when DELETE file storage removal fails so client/job can retry (#005)', async () => {
    let failDelete = true;
    const { app, storageMap, files, registeredFiles } = setupTestHarness({
      deleteStorageImpl: async () => {
        if (failDelete) throw new Error('R2 temporary failure');
      },
    });

    const uploadRes = await app.request(
      createUploadRequest('/api/workspaces/ws-1/projects/proj-1/uploads', validPngBytes, 'retry.png'),
    );
    expect(uploadRes.status).toBe(200);
    const { key } = (await uploadRes.json()) as { key: string };

    const deleteFail = await app.request(
      `/api/workspaces/ws-1/projects/proj-1/files/${encodeURIComponent(key)}`,
      { method: 'DELETE' },
    );
    expect(deleteFail.status).toBe(500);
    // Registration must remain so a retry succeeds cleanly
    expect(registeredFiles.some((f) => f.storageKey === key)).toBe(true);
    expect(storageMap.has(key)).toBe(true);

    failDelete = false;
    const deleteRetry = await app.request(
      `/api/workspaces/ws-1/projects/proj-1/files/${encodeURIComponent(key)}`,
      { method: 'DELETE' },
    );
    expect(deleteRetry.status).toBe(200);
    expect(await files.findByProjectAndKey('proj-1', key)).toBeNull();
    expect(storageMap.has(key)).toBe(false);
  });

  it('rejects deleting a file actively used as a notepad cover (409) and cleans unregistered notepad covers on delete (#005)', async () => {
    const { app, storageMap, storage, registeredFiles } = setupTestHarness({
      coverCountImpl: async () => 1,
    });

    const uploadRes = await app.request(
      createUploadRequest('/api/workspaces/ws-1/projects/proj-1/uploads', validPngBytes, 'cover.png'),
    );
    const { key } = (await uploadRes.json()) as { key: string };

    const blocked = await app.request(
      `/api/workspaces/ws-1/projects/proj-1/files/${encodeURIComponent(key)}`,
      { method: 'DELETE' },
    );
    expect(blocked.status).toBe(409);
    expect(registeredFiles.some((f) => f.storageKey === key)).toBe(true);

    // Unregistered cover cleanup on NotepadService.permanentDeleteNotepad with single retry on transient failure
    const unregisteredCoverKey = 'ws-1/proj-1/unregistered-cover.png';
    await storage.put(unregisteredCoverKey, validPngBytes, 'image/png');
    let attempts = 0;
    const retryStorage: IStorageAdapter = {
      ...storage,
      async delete(k) {
        attempts++;
        if (attempts === 1) throw new Error('Transient storage error');
        storageMap.delete(k);
      },
    };
    const notepadRepo: Partial<INotepadRepository> = {
      findByIdInScope: vi.fn(async () => ({
        id: 'note-1',
        workspaceId: 'ws-1',
        projectId: 'proj-1',
        parentId: null,
        kind: 'notepad' as const,
        title: 'Trash note',
        icon: null,
        coverKey: unregisteredCoverKey,
        content: '[]',
        version: 1,
        position: 'a0',
        isFavorite: false,
        deletedAt: 1000,
        deletionOperationId: null,
        createdBy: 'user-1',
        createdAt: 1000,
        updatedAt: 1000,
      })),
      hardDelete: vi.fn(async () => [{ id: 'note-1', coverKey: unregisteredCoverKey }]),
      countByCoverKey: vi.fn(async () => 0),
    };
    const fileRepo: Partial<IProjectFileRepository> = {
      countByStorageKey: vi.fn(async () => 0),
    };
    const service = new NotepadService(
      {
        notepads: notepadRepo as INotepadRepository,
        tags: {} as ITagRepository,
        members: {} as IMemberRepository,
        projectFiles: fileRepo as IProjectFileRepository,
      },
      {} as ILockAdapter,
      retryStorage,
    );

    await service.permanentDeleteNotepad({
      workspaceId: 'ws-1',
      projectId: 'proj-1',
      notepadId: 'note-1',
      actorUserId: 'user-1',
    });

    expect(attempts).toBe(2);
    expect(storageMap.has(unregisteredCoverKey)).toBe(false);
  });

  it('caps Worker project upload policy at WORKER_MAX_UPLOAD_BYTES (25 MB) (#008)', async () => {
    const { app } = setupTestHarness({
      role: 'owner',
      maxUploadBytes: WORKER_MAX_UPLOAD_BYTES,
    });

    const tooHigh = await app.request('/api/workspaces/ws-1/projects/proj-1/upload-policy', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        maxFileSizeBytes: WORKER_MAX_UPLOAD_BYTES + 1,
        allowedMimeTypes: ['image/png'],
      }),
    });
    expect(tooHigh.status).toBe(400);

    const withinWorkerLimit = await app.request(
      '/api/workspaces/ws-1/projects/proj-1/upload-policy',
      {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          maxFileSizeBytes: WORKER_MAX_UPLOAD_BYTES,
          allowedMimeTypes: ['image/png'],
        }),
      },
    );
    expect(withinWorkerLimit.status).toBe(200);
  });
});

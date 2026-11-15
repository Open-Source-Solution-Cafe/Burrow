import postgres from 'postgres';
import { afterEach, beforeEach, describe, expect, inject, it } from 'vitest';
import type { IStorageAdapter } from '../../src/core/adapters/storage/types';
import { SqlLockAdapter } from '../../src/core/adapters/db/d1/adapters/lock/sql-lock';
import { NotepadService } from '../../src/core/services/notepads';
import { ProjectService } from '../../src/core/services/projects';
import { StorageCleanupService } from '../../src/core/services/storage-cleanup';
import { uploadPolicyStorageKey } from '../../src/shared/uploadPolicy';
import { openPersistence, type PersistenceFixture } from './node-fixture';

function createFlakyStorage() {
  const objects = new Map<string, { body: Uint8Array; contentType: string }>();
  const failKeys = new Map<string, number>();
  const deletedOrder: string[] = [];

  const storage: IStorageAdapter = {
    async put(key, data, contentType = 'application/octet-stream') {
      objects.set(key, {
        body: data instanceof Uint8Array ? data : new Uint8Array(data),
        contentType,
      });
    },
    async get(key) {
      return objects.get(key) ?? null;
    },
    async delete(key) {
      const remainingFailures = failKeys.get(key) ?? 0;
      if (remainingFailures > 0) {
        failKeys.set(key, remainingFailures - 1);
        throw new Error(`simulated storage failure for ${key}`);
      }
      deletedOrder.push(key);
      objects.delete(key);
    },
    async deletePrefix(prefix) {
      for (const key of [...objects.keys()]) {
        if (key.startsWith(prefix)) objects.delete(key);
      }
    },
    async listObjects() {
      return [...objects.keys()].sort();
    },
  };

  return {
    storage,
    objects,
    failKeys,
    deletedOrder,
  };
}

describe.each(['sqlite', 'postgres'] as const)(
  '%s durable storage cleanup under foreign-key enforcement',
  (kind) => {
    let fixture: PersistenceFixture;
    let admin: ReturnType<typeof postgres> | undefined;
    let database: string | undefined;

    const id = () => crypto.randomUUID();

    beforeEach(async () => {
      let url = inject('postgresTestUrl');
      if (kind === 'postgres') {
        admin = postgres(url, { max: 1, onnotice: () => {} });
        database = `cleanup_node_${crypto.randomUUID().replaceAll('-', '')}`;
        await admin.unsafe(`CREATE DATABASE "${database}"`);
        const testUrl = new URL(url);
        testUrl.pathname = `/${database}`;
        url = testUrl.toString();
      }
      fixture = await openPersistence(kind, url);
    });

    afterEach(async () => {
      await fixture?.close();
      if (admin && database) await admin.unsafe(`DROP DATABASE "${database}" WITH (FORCE)`);
      await admin?.end();
    });

    async function seedWorkspace() {
      const ownerId = id();
      const workspaceId = id();
      const now = Date.now();
      const authFields = kind === 'postgres' ? 'created_at, updated_at' : '"createdAt", "updatedAt"';
      const authTs = kind === 'postgres' ? new Date(now).toISOString() : now;

      await fixture.query(
        `INSERT INTO "user" (id, name, email, ${authFields}) VALUES (?, ?, ?, ?, ?)`,
        [ownerId, 'Cleanup Owner', `${ownerId}@cleanup.test`, authTs, authTs],
      );
      await fixture.query(
        'INSERT INTO workspaces (id, name, created_by, created_at) VALUES (?, ?, ?, ?)',
        [workspaceId, 'Cleanup Workspace', ownerId, now],
      );
      await fixture.query(
        'INSERT INTO members (workspace_id, user_id, role, joined_at) VALUES (?, ?, ?, ?)',
        [workspaceId, ownerId, 'owner', now],
      );
      return { ownerId, workspaceId, now };
    }

    it('queues pending deletions atomically before project delete, survives storage failures without FK reinsert errors, preserves shared files, and retries idempotently', async () => {
      if (kind === 'sqlite') {
        const fk = await fixture.query('PRAGMA foreign_keys');
        expect(Object.values(fk[0] ?? {})[0]).toBe(1);
      }

      const { ownerId, workspaceId, now } = await seedWorkspace();
      const projectToDelete = id();
      const survivingProject = id();
      for (const [projectId, name] of [
        [projectToDelete, 'Target Project'],
        [survivingProject, 'Surviving Project'],
      ] as const) {
        await fixture.query(
          'INSERT INTO projects (id, workspace_id, name, position, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)',
          [projectId, workspaceId, name, 'a0', now, now],
        );
      }

      const flaky = createFlakyStorage();
      const uniqueKey = `${workspaceId}/${projectToDelete}/unique.png`;
      const sharedKey = `${workspaceId}/${survivingProject}/shared.png`;
      const unlinkedCoverKey = `${workspaceId}/${projectToDelete}/cover-only.jpg`;
      const policyKey = uploadPolicyStorageKey(workspaceId, projectToDelete);

      for (const key of [uniqueKey, sharedKey, unlinkedCoverKey, policyKey]) {
        await flaky.storage.put(key, new Uint8Array([1, 2, 3, 4]));
      }

      // Register unique + shared files on target project, and keep shared file in surviving project
      await fixture.projectFiles.register({
        projectId: projectToDelete,
        storageKey: uniqueKey,
        contentType: 'image/png',
        createdBy: ownerId,
        createdAt: now,
      });
      await fixture.projectFiles.register({
        projectId: projectToDelete,
        storageKey: sharedKey,
        contentType: 'image/png',
        createdBy: ownerId,
        createdAt: now,
      });
      await fixture.projectFiles.register({
        projectId: survivingProject,
        storageKey: sharedKey,
        contentType: 'image/png',
        createdBy: ownerId,
        createdAt: now,
      });

      // Add notepad with cover-only key inside deleted project
      const noteId = id();
      await fixture.query(
        `INSERT INTO notepads
          (id, workspace_id, project_id, parent_id, kind, title, cover_key, content, version, position, created_by, created_at, updated_at)
         VALUES (?, ?, ?, NULL, 'notepad', 'Deleted Note', ?, '[]', 1, 'a0', ?, ?, ?)`,
        [noteId, workspaceId, projectToDelete, unlinkedCoverKey, ownerId, now, now],
      );

      // Fail storage.delete for uniqueKey twice before succeeding on attempt 3
      flaky.failKeys.set(uniqueKey, 2);

      const projectService = new ProjectService(
        {
          projects: fixture.projects,
          notepads: fixture.notepads,
          members: fixture.createMembers(),
          projectFiles: fixture.projectFiles,
          storageDeletions: fixture.storageDeletions,
        },
        flaky.storage,
      );

      // Must NOT fail or attempt FK-violating project_files reinsertion when storage.delete throws
      await projectService.permanentDeleteProject({
        workspaceId,
        actorUserId: ownerId,
        projectId: projectToDelete,
        confirmName: 'Target Project',
      });

      expect(await fixture.query('SELECT id FROM projects WHERE id = ?', [projectToDelete])).toEqual(
        [],
      );
      expect(await fixture.projectFiles.countByStorageKey(uniqueKey)).toBe(0);
      expect(await fixture.projectFiles.countByStorageKey(sharedKey)).toBe(1);

      // Shared file stays intact; unlinked cover & policy succeed; uniqueKey stays queued with attempt metadata
      expect(await flaky.storage.get(sharedKey)).not.toBeNull();
      expect(await flaky.storage.get(unlinkedCoverKey)).toBeNull();
      expect(await flaky.storage.get(policyKey)).toBeNull();
      expect(await flaky.storage.get(uniqueKey)).not.toBeNull();

      const pendingAfterFirstAttempt = await fixture.storageDeletions.listAll();
      expect(pendingAfterFirstAttempt).toHaveLength(1);
      expect(pendingAfterFirstAttempt[0]).toMatchObject({
        storageKey: uniqueKey,
        projectId: projectToDelete,
        workspaceId,
        attempts: 1,
      });
      expect(pendingAfterFirstAttempt[0]?.lastError).toContain('simulated storage failure');
      expect(pendingAfterFirstAttempt[0]!.nextRetryAt).toBeGreaterThan(now);

      const cleanupService = new StorageCleanupService(
        {
          projectFiles: fixture.projectFiles,
          notepads: fixture.notepads,
          projects: fixture.projects,
          storageDeletions: fixture.storageDeletions,
        },
        flaky.storage,
      );

      // Backoff window prevents immediate hammer before nextRetryAt
      const skippedBackoff = await cleanupService.processPending({
        now: pendingAfterFirstAttempt[0]!.nextRetryAt - 100,
      });
      expect(skippedBackoff.processed).toBe(0);

      // Second attempt still simulates failure -> preserves row and increments attempts to 2
      const secondAttempt = await cleanupService.processPending({
        now: pendingAfterFirstAttempt[0]!.nextRetryAt + 1,
      });
      expect(secondAttempt.failed).toBe(1);
      expect(secondAttempt.failedKeys).toEqual([uniqueKey]);
      const pendingAfterSecond = await fixture.storageDeletions.listAll();
      expect(pendingAfterSecond).toHaveLength(1);
      expect(pendingAfterSecond[0]?.attempts).toBe(2);

      // Third attempt succeeds cleanly and deletes uniqueKey + pending row
      const thirdAttempt = await cleanupService.processPending({
        now: pendingAfterSecond[0]!.nextRetryAt + 1,
      });
      expect(thirdAttempt.deleted).toBe(1);
      expect(thirdAttempt.failed).toBe(0);
      expect(await flaky.storage.get(uniqueKey)).toBeNull();
      expect(await fixture.storageDeletions.listAll()).toEqual([]);

      // Retrying again is strictly idempotent
      const fourthAttempt = await cleanupService.processPending({ now: Date.now() + 600_000 });
      expect(fourthAttempt).toEqual({
        processed: 0,
        deleted: 0,
        skippedReferenced: 0,
        failed: 0,
        failedKeys: [],
      });
      expect(await flaky.storage.get(sharedKey)).not.toBeNull();
    });

    it('queues notepad cover deletion under failure and safely reconciles only true orphans', async () => {
      const { ownerId, workspaceId, now } = await seedWorkspace();
      const projectId = id();
      await fixture.query(
        'INSERT INTO projects (id, workspace_id, name, position, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)',
        [projectId, workspaceId, 'Orphan Project', 'a0', now, now],
      );

      const flaky = createFlakyStorage();
      const liveRegisteredKey = `${workspaceId}/${projectId}/live-file.png`;
      const livePolicyKey = uploadPolicyStorageKey(workspaceId, projectId);
      const orphanKey = `${workspaceId}/${projectId}/dangling-orphan.png`;
      const trashedNoteCover = `${workspaceId}/${projectId}/trashed-cover.jpg`;
      const protectedExcludeKey = 'system/keep-me.bin';

      for (const key of [
        liveRegisteredKey,
        livePolicyKey,
        orphanKey,
        trashedNoteCover,
        protectedExcludeKey,
      ]) {
        await flaky.storage.put(key, new Uint8Array([9, 8, 7]));
      }

      await fixture.projectFiles.register({
        projectId,
        storageKey: liveRegisteredKey,
        contentType: 'image/png',
        createdBy: ownerId,
        createdAt: now,
      });

      const trashedNoteId = id();
      await fixture.query(
        `INSERT INTO notepads
          (id, workspace_id, project_id, parent_id, kind, title, cover_key, content, version, position, deleted_at, deletion_operation_id, created_by, created_at, updated_at)
         VALUES (?, ?, ?, NULL, 'notepad', 'Trashed Note', ?, '[]', 1, 'a0', ?, ?, ?, ?, ?)`,
        [trashedNoteId, workspaceId, projectId, trashedNoteCover, now, id(), ownerId, now, now],
      );

      flaky.failKeys.set(trashedNoteCover, 1);

      const notepadService = new NotepadService(
        {
          notepads: fixture.notepads,
          tags: fixture.tags,
          members: fixture.createMembers(),
          projectFiles: fixture.projectFiles,
          projects: fixture.projects,
          storageDeletions: fixture.storageDeletions,
        },
        fixture.locks ?? new SqlLockAdapter({} as never),
        flaky.storage,
      );

      await notepadService.permanentDeleteNotepad({
        workspaceId,
        projectId,
        actorUserId: ownerId,
        notepadId: trashedNoteId,
      });

      // Failed storage deletion retains trashedNoteCover in pending_storage_deletions
      const pending = await fixture.storageDeletions.listAll();
      expect(pending.map((row) => row.storageKey)).toEqual([trashedNoteCover]);
      expect(await flaky.storage.get(trashedNoteCover)).not.toBeNull();

      // Reconcile while retry succeeds and verify only genuine orphan is deleted
      const cleanup = new StorageCleanupService(
        {
          projectFiles: fixture.projectFiles,
          notepads: fixture.notepads,
          projects: fixture.projects,
          storageDeletions: fixture.storageDeletions,
        },
        flaky.storage,
      );

      const recon = await cleanup.reconcileOrphanedObjects({
        now: pending[0]!.nextRetryAt + 100,
        deleteOrphans: true,
        excludeKeys: [protectedExcludeKey],
      });

      expect(recon.pendingResult.deleted).toBe(1);
      expect(recon.orphanKeys).toEqual([orphanKey]);
      expect(recon.deletedOrphans).toEqual([orphanKey]);
      expect(await flaky.storage.get(trashedNoteCover)).toBeNull();
      expect(await flaky.storage.get(orphanKey)).toBeNull();
      expect(await flaky.storage.get(liveRegisteredKey)).not.toBeNull();
      expect(await flaky.storage.get(livePolicyKey)).not.toBeNull();
      expect(await flaky.storage.get(protectedExcludeKey)).not.toBeNull();
    });

    it('rolls back queued pending_storage_deletions when project deletion fails mid-transaction', async () => {
      const { ownerId, workspaceId, now } = await seedWorkspace();
      const projectId = id();
      await fixture.query(
        'INSERT INTO projects (id, workspace_id, name, position, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)',
        [projectId, workspaceId, 'Rollback Project', 'a0', now, now],
      );

      const flaky = createFlakyStorage();
      const fileKey = `${workspaceId}/${projectId}/rollback.png`;
      await flaky.storage.put(fileKey, new Uint8Array([7, 7, 7]));
      await fixture.projectFiles.register({
        projectId,
        storageKey: fileKey,
        contentType: 'image/png',
        createdBy: ownerId,
        createdAt: now,
      });

      if (kind === 'sqlite') {
        await fixture.query(
          `CREATE TRIGGER abort_project_delete BEFORE DELETE ON projects
           BEGIN SELECT RAISE(ABORT, 'simulated project delete failure'); END`,
        );
      } else {
        await fixture.query(
          `CREATE OR REPLACE FUNCTION abort_project_delete_fn() RETURNS trigger AS $$
           BEGIN RAISE EXCEPTION 'simulated project delete failure'; END;
           $$ LANGUAGE plpgsql`,
        );
        await fixture.query(
          `CREATE TRIGGER abort_project_delete BEFORE DELETE ON projects
           FOR EACH ROW EXECUTE FUNCTION abort_project_delete_fn()`,
        );
      }

      const projectService = new ProjectService(
        {
          projects: fixture.projects,
          notepads: fixture.notepads,
          members: fixture.createMembers(),
          projectFiles: fixture.projectFiles,
          storageDeletions: fixture.storageDeletions,
        },
        flaky.storage,
      );

      await expect(
        projectService.permanentDeleteProject({
          workspaceId,
          actorUserId: ownerId,
          projectId,
          confirmName: 'Rollback Project',
        }),
      ).rejects.toThrow();

      // Transaction rolled back: project, file reference, queued pending row, and object stay intact
      expect(await fixture.query('SELECT id FROM projects WHERE id = ?', [projectId])).toHaveLength(1);
      expect(await fixture.projectFiles.countByStorageKey(fileKey)).toBe(1);
      expect(await fixture.storageDeletions.listAll()).toEqual([]);
      expect(await flaky.storage.get(fileKey)).not.toBeNull();
    });
  },
);

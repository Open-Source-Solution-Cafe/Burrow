import { isUploadPolicyStorageKey } from '../../shared/uploadPolicy';
import type { IStorageAdapter } from '../adapters/storage/types';
import type { RepositoryContainer } from '../infrastructure/types';

export interface ProcessPendingCleanupResult {
  processed: number;
  deleted: number;
  skippedReferenced: number;
  failed: number;
  failedKeys: string[];
}

export interface ReconcileOrphanedObjectsResult {
  pendingResult: ProcessPendingCleanupResult;
  orphanKeys: string[];
  deletedOrphans: string[];
  failedOrphans: string[];
}

const DEFAULT_LEASE_MS = 30_000;
const MAX_BACKOFF_MS = 30 * 60_000;

export function computeStorageRetryBackoffMs(attemptNumber: number): number {
  const exponent = Math.max(0, Math.min(10, attemptNumber - 1));
  return Math.min(MAX_BACKOFF_MS, 1000 * 2 ** exponent);
}

function parseUploadPolicyScope(key: string): { workspaceId: string; projectId: string } | null {
  if (!isUploadPolicyStorageKey(key)) return null;
  const [workspaceId, projectId] = key.split('/');
  if (!workspaceId || !projectId) return null;
  return { workspaceId, projectId };
}

function formatErrorMessage(error: unknown): string {
  if (error instanceof Error) return error.message || error.name;
  return String(error);
}

/**
 * Coordinates durable, retryable storage object deletion backed by `pending_storage_deletions`.
 * Always verifies live DB references (`project_files`, `notepads.cover_key`, and live project
 * upload policies) before deleting objects so shared keys remain intact.
 */
export class StorageCleanupService {
  constructor(
    private readonly repos: Pick<RepositoryContainer, 'projectFiles' | 'notepads' | 'storageDeletions'> & {
      projects?: RepositoryContainer['projects'];
    },
    private readonly storage: IStorageAdapter,
  ) {}

  private async isKeyReferencedInDatabase(key: string): Promise<boolean> {
    const policyScope = parseUploadPolicyScope(key);
    if (policyScope) {
      if (!this.repos.projects) return true;
      const liveProject = await this.repos.projects.findByIdAndWorkspace(
        policyScope.projectId,
        policyScope.workspaceId,
      );
      return liveProject !== null;
    }

    const [registrations, covers] = await Promise.all([
      this.repos.projectFiles.countByStorageKey(key),
      this.repos.notepads.countByCoverKey(key),
    ]);
    return registrations > 0 || covers > 0;
  }

  async processPending(options: { now?: number; limit?: number } = {}): Promise<ProcessPendingCleanupResult> {
    const storageDeletions = this.repos.storageDeletions;
    if (!storageDeletions) {
      return { processed: 0, deleted: 0, skippedReferenced: 0, failed: 0, failedKeys: [] };
    }

    const now = options.now ?? Date.now();
    const due = await storageDeletions.listDue(now, options.limit ?? 50);

    let processed = 0;
    let deleted = 0;
    let skippedReferenced = 0;
    let failed = 0;
    const failedKeys: string[] = [];

    for (const item of due) {
      const claimed = await storageDeletions.claimForProcessing(
        item.id,
        now,
        now + DEFAULT_LEASE_MS,
      );
      if (!claimed) continue;

      processed += 1;
      try {
        if (await this.isKeyReferencedInDatabase(item.storageKey)) {
          await storageDeletions.complete(item.id);
          skippedReferenced += 1;
          continue;
        }

        await this.storage.delete(item.storageKey);
        await storageDeletions.complete(item.id);
        deleted += 1;
      } catch (error) {
        const nextRetryAt = now + computeStorageRetryBackoffMs(item.attempts + 1);
        await storageDeletions.markAttemptFailed(
          item.id,
          item.attempts,
          formatErrorMessage(error),
          nextRetryAt,
        );
        failed += 1;
        failedKeys.push(item.storageKey);
      }
    }

    return { processed, deleted, skippedReferenced, failed, failedKeys };
  }

  async reconcileOrphanedObjects(
    options: {
      now?: number;
      deleteOrphans?: boolean;
      excludeKeys?: readonly string[];
      pendingLimit?: number;
    } = {},
  ): Promise<ReconcileOrphanedObjectsResult> {
    const now = options.now ?? Date.now();
    const pendingResult = await this.processPending({ now, limit: options.pendingLimit ?? 100 });

    const [registeredKeys, coverKeys, policyKeys, pendingRows, storedKeys] = await Promise.all([
      this.repos.projectFiles.listAllStorageKeys(),
      this.repos.notepads.listAllCoverKeys?.() ?? Promise.resolve([]),
      this.repos.projects?.listAllPolicyKeys?.() ?? Promise.resolve<string[] | null>(null),
      this.repos.storageDeletions?.listAll(1000) ?? Promise.resolve([]),
      this.storage.listObjects(),
    ]);

    const protectedKeys = new Set<string>([
      ...registeredKeys,
      ...coverKeys,
      ...(policyKeys ?? []),
      ...pendingRows.map((row) => row.storageKey),
      ...(options.excludeKeys ?? []),
    ]);

    const orphanKeys: string[] = [];
    for (const key of storedKeys) {
      if (protectedKeys.has(key)) continue;
      if (policyKeys === null) {
        const policyScope = parseUploadPolicyScope(key);
        if (policyScope) {
          if (!this.repos.projects) continue;
          const liveProject = await this.repos.projects.findByIdAndWorkspace(
            policyScope.projectId,
            policyScope.workspaceId,
          );
          if (liveProject) continue;
        }
      }
      orphanKeys.push(key);
    }

    const deletedOrphans: string[] = [];
    const failedOrphans: string[] = [];

    if (options.deleteOrphans) {
      for (const key of orphanKeys) {
        try {
          if (await this.isKeyReferencedInDatabase(key)) continue;
          await this.storage.delete(key);
          deletedOrphans.push(key);
        } catch {
          failedOrphans.push(key);
        }
      }
    }

    return {
      pendingResult,
      orphanKeys,
      deletedOrphans,
      failedOrphans,
    };
  }
}

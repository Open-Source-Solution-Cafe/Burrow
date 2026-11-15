import { and, asc, eq, lte, sql } from 'drizzle-orm';
import { nanoid } from 'nanoid';
import type { DB } from '../client';
import * as t from '../schema';
import type {
  EnqueueStorageDeletionInput,
  IStorageDeletionRepository,
  PendingStorageDeletion,
  StorageDeletionReason,
} from '../../../../infrastructure/types';

export function createStorageDeletionRepository(db: DB): IStorageDeletionRepository {
  return {
    async enqueue(items: EnqueueStorageDeletionInput[]): Promise<void> {
      if (items.length === 0) return;
      const defaultNow = Date.now();
      const values = items.map((item) => ({
        id: item.id ?? nanoid(),
        storageKey: item.storageKey,
        projectId: item.projectId ?? null,
        workspaceId: item.workspaceId ?? null,
        reason: item.reason,
        attempts: 0,
        lastError: null,
        createdAt: item.createdAt ?? defaultNow,
        nextRetryAt: item.nextRetryAt ?? item.createdAt ?? defaultNow,
      }));
      await db.insert(t.pendingStorageDeletions).values(values).onConflictDoNothing();
    },

    async listDue(now: number, limit = 50): Promise<PendingStorageDeletion[]> {
      const rows = await db
        .select()
        .from(t.pendingStorageDeletions)
        .where(lte(t.pendingStorageDeletions.nextRetryAt, now))
        .orderBy(asc(t.pendingStorageDeletions.nextRetryAt), asc(t.pendingStorageDeletions.createdAt))
        .limit(limit);
      return rows.map(mapRow);
    },

    async listAll(limit = 500): Promise<PendingStorageDeletion[]> {
      const rows = await db
        .select()
        .from(t.pendingStorageDeletions)
        .orderBy(asc(t.pendingStorageDeletions.createdAt))
        .limit(limit);
      return rows.map(mapRow);
    },

    async claimForProcessing(id: string, now: number, leaseUntil: number): Promise<boolean> {
      const rows = await db
        .update(t.pendingStorageDeletions)
        .set({ nextRetryAt: leaseUntil })
        .where(
          and(
            eq(t.pendingStorageDeletions.id, id),
            lte(t.pendingStorageDeletions.nextRetryAt, now),
          ),
        )
        .returning({ id: t.pendingStorageDeletions.id });
      return rows.length === 1;
    },

    async markAttemptFailed(
      id: string,
      expectedAttempts: number,
      lastError: string,
      nextRetryAt: number,
    ): Promise<boolean> {
      const rows = await db
        .update(t.pendingStorageDeletions)
        .set({
          attempts: expectedAttempts + 1,
          lastError: lastError.slice(0, 500),
          nextRetryAt,
        })
        .where(
          and(
            eq(t.pendingStorageDeletions.id, id),
            eq(t.pendingStorageDeletions.attempts, expectedAttempts),
          ),
        )
        .returning({ id: t.pendingStorageDeletions.id });
      return rows.length === 1;
    },

    async complete(id: string): Promise<void> {
      await db.delete(t.pendingStorageDeletions).where(eq(t.pendingStorageDeletions.id, id));
    },

    async hasPendingForKey(storageKey: string): Promise<boolean> {
      const [row] = await db
        .select({ count: sql<number>`count(*)` })
        .from(t.pendingStorageDeletions)
        .where(eq(t.pendingStorageDeletions.storageKey, storageKey));
      return Number(row?.count ?? 0) > 0;
    },
  };
}

function mapRow(row: typeof t.pendingStorageDeletions.$inferSelect): PendingStorageDeletion {
  return {
    id: row.id,
    storageKey: row.storageKey,
    projectId: row.projectId ?? null,
    workspaceId: row.workspaceId ?? null,
    reason: row.reason as StorageDeletionReason,
    attempts: Number(row.attempts),
    lastError: row.lastError ?? null,
    createdAt: Number(row.createdAt),
    nextRetryAt: Number(row.nextRetryAt),
  };
}

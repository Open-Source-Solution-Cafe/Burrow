import { and, asc, eq, lte, sql } from 'drizzle-orm';
import { nanoid } from 'nanoid';
import type {
  EnqueueStorageDeletionInput,
  IStorageDeletionRepository,
  PendingStorageDeletion,
  StorageDeletionReason,
} from '../../../../infrastructure/types';
import type { PostgresDb } from '../index';
import { pendingStorageDeletions } from '../schema';

export class PostgresStorageDeletionRepository implements IStorageDeletionRepository {
  constructor(private readonly db: PostgresDb) {}

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
    await this.db.insert(pendingStorageDeletions).values(values).onConflictDoNothing();
  }

  async listDue(now: number, limit = 50): Promise<PendingStorageDeletion[]> {
    const rows = await this.db
      .select()
      .from(pendingStorageDeletions)
      .where(lte(pendingStorageDeletions.nextRetryAt, now))
      .orderBy(asc(pendingStorageDeletions.nextRetryAt), asc(pendingStorageDeletions.createdAt))
      .limit(limit);
    return rows.map(mapRow);
  }

  async listAll(limit = 500): Promise<PendingStorageDeletion[]> {
    const rows = await this.db
      .select()
      .from(pendingStorageDeletions)
      .orderBy(asc(pendingStorageDeletions.createdAt))
      .limit(limit);
    return rows.map(mapRow);
  }

  async claimForProcessing(id: string, now: number, leaseUntil: number): Promise<boolean> {
    const rows = await this.db
      .update(pendingStorageDeletions)
      .set({ nextRetryAt: leaseUntil })
      .where(
        and(eq(pendingStorageDeletions.id, id), lte(pendingStorageDeletions.nextRetryAt, now)),
      )
      .returning({ id: pendingStorageDeletions.id });
    return rows.length === 1;
  }

  async markAttemptFailed(
    id: string,
    expectedAttempts: number,
    lastError: string,
    nextRetryAt: number,
  ): Promise<boolean> {
    const rows = await this.db
      .update(pendingStorageDeletions)
      .set({
        attempts: expectedAttempts + 1,
        lastError: lastError.slice(0, 500),
        nextRetryAt,
      })
      .where(
        and(
          eq(pendingStorageDeletions.id, id),
          eq(pendingStorageDeletions.attempts, expectedAttempts),
        ),
      )
      .returning({ id: pendingStorageDeletions.id });
    return rows.length === 1;
  }

  async complete(id: string): Promise<void> {
    await this.db.delete(pendingStorageDeletions).where(eq(pendingStorageDeletions.id, id));
  }

  async hasPendingForKey(storageKey: string): Promise<boolean> {
    const [row] = await this.db
      .select({ count: sql<number>`count(*)` })
      .from(pendingStorageDeletions)
      .where(eq(pendingStorageDeletions.storageKey, storageKey));
    return Number(row?.count ?? 0) > 0;
  }
}

function mapRow(row: typeof pendingStorageDeletions.$inferSelect): PendingStorageDeletion {
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

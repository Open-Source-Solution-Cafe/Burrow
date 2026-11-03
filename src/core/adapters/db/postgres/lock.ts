import type { ILockAdapter, LockAcquireResult, LockAcquireOptions } from '../../../adapters/lock';
import { eq, and, lte, gt, or } from 'drizzle-orm';
import type { PostgresDb } from './index';
import { editLocks } from './schema';
import { withNotepadTransaction } from './notepad-transaction';

export class PostgresLockAdapter implements ILockAdapter {
  constructor(private db: PostgresDb) {}

  acquire(
    resourceId: string,
    userId: string,
    clientId: string,
    ttlMs: number,
    options?: LockAcquireOptions,
  ): Promise<LockAcquireResult> {
    return withNotepadTransaction(this.db, resourceId, async (tx) => {
      const now = Date.now();
      const expiresAt = now + ttlMs;
      const [acquired] = await tx
        .insert(editLocks)
        .values({ notepadId: resourceId, userId, clientId, expiresAt })
        .onConflictDoUpdate({
          target: editLocks.notepadId,
          set: { userId, clientId, expiresAt },
          where: or(
            lte(editLocks.expiresAt, now),
            and(eq(editLocks.userId, userId), eq(editLocks.clientId, clientId)),
            ...(options?.takeover ? [eq(editLocks.userId, userId)] : []),
          ),
        })
        .returning({ id: editLocks.notepadId });
      if (acquired) return { acquired: true, expiresAt };
      const [holder] = await tx
        .select({
          holderUserId: editLocks.userId,
          expiresAt: editLocks.expiresAt,
        })
        .from(editLocks)
        .where(eq(editLocks.notepadId, resourceId));
      return {
        acquired: false,
        holderUserId: holder?.holderUserId,
        expiresAt: holder?.expiresAt,
      };
    });
  }

  heartbeat(resourceId: string, clientId: string, ttlMs: number): Promise<boolean> {
    return withNotepadTransaction(this.db, resourceId, async (tx) => {
      const now = Date.now();
      const result = await tx
        .update(editLocks)
        .set({ expiresAt: now + ttlMs })
        .where(
          and(
            eq(editLocks.notepadId, resourceId),
            eq(editLocks.clientId, clientId),
            gt(editLocks.expiresAt, now),
          ),
        )
        .returning({ id: editLocks.notepadId });
      return result.length > 0;
    });
  }

  release(resourceId: string, clientId: string, options?: { userId: string }): Promise<void> {
    return withNotepadTransaction(this.db, resourceId, async (tx) => {
      await tx
        .delete(editLocks)
        .where(
          and(
            eq(editLocks.notepadId, resourceId),
            eq(editLocks.clientId, clientId),
            options?.userId ? eq(editLocks.userId, options.userId) : undefined,
          ),
        );
    });
  }
}

import { and, eq } from 'drizzle-orm';
import type { PostgresDb } from './index';
import type { NotepadMutationScope } from '../../../infrastructure/types';
import { members, notepads, workspaces } from './schema';

type Transaction = Parameters<Parameters<PostgresDb['transaction']>[0]>[0];

/** Serialize saves and edit-lock changes even when no edit_locks row exists. */
export function withNotepadTransaction<T>(
  db: PostgresDb,
  notepadId: string,
  operation: (tx: Transaction) => Promise<T>,
): Promise<T> {
  return db.transaction(async (tx) => {
    await tx
      .select({ id: notepads.id })
      .from(notepads)
      .where(eq(notepads.id, notepadId))
      .for('update');
    return operation(tx);
  });
}

/** Serialize note writes with membership changes, then recheck the actor role. */
export function withNotepadWrite<T>(
  db: PostgresDb,
  scope: NotepadMutationScope,
  operation: (tx: Transaction) => Promise<T>,
): Promise<T | null> {
  return db.transaction(async (tx) => {
    const [workspace] = await tx
      .select({ id: workspaces.id })
      .from(workspaces)
      .where(eq(workspaces.id, scope.workspaceId))
      .for('update');
    if (!workspace) return null;
    const [member] = await tx
      .select({ role: members.role })
      .from(members)
      .where(and(eq(members.workspaceId, scope.workspaceId), eq(members.userId, scope.actorUserId)));
    if (!member || (scope.minimumRole === 'owner' ? member.role !== 'owner' : member.role === 'viewer')) {
      return null;
    }
    return operation(tx);
  });
}

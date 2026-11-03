import { sql, and, eq, inArray, isNull, type SQL } from 'drizzle-orm';
import type { BatchItem } from 'drizzle-orm/batch';
import type { ExtractedLink as StoredLink } from '../../../../../shared/extract';
export type { ExtractedLink as StoredLink } from '../../../../../shared/extract';
import type { DB } from '../client';
import * as t from '../schema';
import type { ProjectScope } from '../../../../infrastructure/types';
import { resolveReferenceTargets } from '../../../../shared/links';
import { chunkByParamBudget, chunkInList } from '../../../../services/utils/chunk';

/** Scoped, live target IDs; reused by bulk validation and backlink resolution. */
export function projectTargetQuery(
  db: DB,
  scope: ProjectScope,
  type: StoredLink['targetType'],
  ids: string[],
) {
  if (type === 'user') {
    return db
      .select({ id: t.members.userId })
      .from(t.members)
      .where(and(eq(t.members.workspaceId, scope.workspaceId), inArray(t.members.userId, ids)));
  }
  if (type === 'notepad') {
    return db
      .select({ id: t.notepads.id })
      .from(t.notepads)
      .innerJoin(
        t.projects,
        and(
          eq(t.projects.id, t.notepads.projectId),
          eq(t.projects.workspaceId, t.notepads.workspaceId),
        ),
      )
      .where(
        and(
          eq(t.notepads.workspaceId, scope.workspaceId),
          eq(t.notepads.projectId, scope.projectId),
          eq(t.notepads.kind, 'notepad'),
          isNull(t.notepads.deletedAt),
          inArray(t.notepads.id, ids),
        ),
      );
  }
  if (type === 'card') {
    return db
      .select({ id: t.cards.id })
      .from(t.cards)
      .innerJoin(t.notepads, eq(t.notepads.id, t.cards.notepadId))
      .innerJoin(
        t.boards,
        and(
          eq(t.boards.id, t.cards.boardId),
          eq(t.boards.workspaceId, t.notepads.workspaceId),
          eq(t.boards.projectId, t.notepads.projectId),
        ),
      )
      .innerJoin(
        t.projects,
        and(
          eq(t.projects.id, t.boards.projectId),
          eq(t.projects.workspaceId, t.boards.workspaceId),
        ),
      )
      .innerJoin(
        t.boardColumns,
        and(eq(t.boardColumns.id, t.cards.columnId), eq(t.boardColumns.boardId, t.boards.id)),
      )
      .where(
        and(
          eq(t.notepads.workspaceId, scope.workspaceId),
          eq(t.notepads.projectId, scope.projectId),
          eq(t.notepads.kind, 'card'),
          isNull(t.notepads.deletedAt),
          isNull(t.boards.deletedAt),
          inArray(t.cards.id, ids),
        ),
      );
  }
  return db
    .select({ id: t.boards.id })
    .from(t.boards)
    .innerJoin(
      t.projects,
      and(eq(t.projects.id, t.boards.projectId), eq(t.projects.workspaceId, t.boards.workspaceId)),
    )
    .where(
      and(
        eq(t.boards.workspaceId, scope.workspaceId),
        eq(t.boards.projectId, scope.projectId),
        isNull(t.boards.deletedAt),
        inArray(t.boards.id, ids),
      ),
    );
}

/** Content targets are live/project-local; user mentions remain workspace-local. */
export async function filterProjectTargets(
  db: DB,
  scope: ProjectScope,
  links: StoredLink[],
): Promise<StoredLink[]> {
  return resolveReferenceTargets(links, async (type, ids) => {
    const valid: string[] = [];
    for (const chunk of chunkInList(ids, type === 'user' ? 1 : type === 'board' ? 2 : 3)) {
      valid.push(...(await projectTargetQuery(db, scope, type, chunk)).map(({ id }) => id));
    }
    return valid;
  });
}

/** Remove `removed` links for `sourceId`, but only if `cond` holds (4 params). */
export function linkDeleteStatements(
  db: DB,
  args: { sourceId: string; removed: StoredLink[]; cond: SQL; condParams: number },
): BatchItem<'sqlite'>[] {
  const { sourceId, removed, cond, condParams } = args;
  if (removed.length === 0) return [];
  // params: source id (1) + (type, id) per link + cond
  const chunks = chunkByParamBudget(removed, 2, 1 + condParams);
  return chunks.map((chunk) => {
    const pairs = chunk.map(
      (l) => sql`(target_type = ${l.targetType} AND target_id = ${l.targetId})`,
    );
    return db.run(
      sql`DELETE FROM notepad_links
          WHERE source_id = ${sourceId}
            AND (${sql.join(pairs, sql` OR `)})
            AND (${cond})`,
    );
  });
}

/**
 * Insert `added` links for `sourceId`, but only if `cond` holds (4 params).
 * Chunked so no statement exceeds D1's 100 bound parameters:
 * 3 params per link (source, type, id) + 4 cond params.
 */
export function linkInsertStatements(
  db: DB,
  args: { sourceId: string; added: StoredLink[]; cond: SQL; condParams: number },
): BatchItem<'sqlite'>[] {
  const { sourceId, added, cond, condParams } = args;
  if (added.length === 0) return [];
  const chunks = chunkByParamBudget(added, 3, condParams);
  return chunks.map((chunk) => {
    const rows = chunk.map((l, i) =>
      i === 0
        ? sql`SELECT ${sourceId} AS src, ${l.targetType} AS typ, ${l.targetId} AS tgt`
        : sql`UNION ALL SELECT ${sourceId}, ${l.targetType}, ${l.targetId}`,
    );
    return db.run(
      sql`INSERT INTO notepad_links (source_id, target_type, target_id)
          SELECT src, typ, tgt FROM (${sql.join(rows, sql` `)}) WHERE (${cond})
          ON CONFLICT DO NOTHING`,
    );
  });
}

/**
 * One `mention` notification per newly mentioned user (actor excluded).
 *
 * Runs BEFORE link inserts and double-guards with NOT EXISTS so a concurrent
 * save of identical content cannot notify twice. Costs 6 params per row
 * (id, workspace, user, actor, notepad, created) + condParams.
 */
export function mentionNotificationStatements(
  db: DB,
  args: {
    workspaceId: string;
    notepadId: string;
    actorId: string;
    addedUserIds: string[];
    cond: SQL;
    condParams: number;
    now: number;
  },
): BatchItem<'sqlite'>[] {
  const { workspaceId, notepadId, actorId, addedUserIds, cond, condParams, now } = args;
  const userIds = [...new Set(addedUserIds)].filter((id) => id !== actorId);
  if (userIds.length === 0) return [];
  const rows = userIds.map((userId) => ({ id: crypto.randomUUID(), userId }));
  const chunks = chunkByParamBudget(rows, 6, condParams);
  return chunks.map((chunk) => {
    const selects = chunk.map((r, i) =>
      i === 0
        ? sql`SELECT ${r.id} AS nid, ${workspaceId} AS wid, ${r.userId} AS uid,
                     ${actorId} AS aid, ${notepadId} AS npid, ${now} AS created`
        : sql`UNION ALL SELECT ${r.id}, ${workspaceId}, ${r.userId}, ${actorId}, ${notepadId}, ${now}`,
    );
    return db.run(
      sql`INSERT INTO notifications
            (id, workspace_id, user_id, type, actor_id, notepad_id, card_id, read_at, created_at)
          SELECT nid, wid, uid, 'mention', aid, npid, NULL, NULL, created
          FROM (${sql.join(selects, sql` `)})
          WHERE (${cond})
            AND NOT EXISTS (
              SELECT 1 FROM notepad_links
              WHERE source_id = npid AND target_type = 'user' AND target_id = uid
            )`,
    );
  });
}

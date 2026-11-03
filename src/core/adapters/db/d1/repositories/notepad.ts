import type { DB } from '../client';
import * as t from '../schema';
import {
  and,
  asc,
  count,
  desc,
  eq,
  inArray,
  isNull,
  isNotNull,
  ne,
  sql,
  or,
  exists,
} from 'drizzle-orm';
import type { BatchItem } from 'drizzle-orm/batch';
import { runBatch } from '../lib/batch';
import { positionAfterLast } from '../../../../services/utils/ordering';
import {
  ftsDeleteStmt,
  ftsInsertStmt,
  ftsInsertNowStmt,
  liveContentCond,
  LIVE_CONTENT_COND_PARAMS,
} from '../lib/search';
import {
  filterProjectTargets,
  projectTargetQuery,
  linkDeleteStatements,
  linkInsertStatements,
  mentionNotificationStatements,
  type StoredLink,
} from '../lib/links';
import { getDescendantIds, getNotepadChildren } from '../lib/tree';
import { chunkByParamBudget, chunkInList } from '../../../../services/utils/chunk';
import { extractPlainText } from '../../../../../shared/extract';
import type { ContentReferenceKind, ReferencePreview } from '../../../../../shared/references';
import type {
  INotepadRepository,
  Notepad,
  CreateNotepadData,
  UpdateNotepadData,
  NotepadContent,
  RestoredNotepad,
  HardDeletedNotepad,
  EditLock,
  SaveContentBatchArgs,
  ProjectScope,
  NotepadMutationScope,
} from '../../../../infrastructure/types';
import { diffLinks } from '../../../../shared/links';
import { MAX_CONTENT_BYTES, contentByteLength } from '../../../../shared/limits';

export function createNotepadRepository(db: DB): INotepadRepository {
  const batchDidWrite = (result: unknown) => Array.isArray(result) && Boolean((result[0] as { results?: unknown[] } | undefined)?.results?.length);
  const writable = (scope: NotepadMutationScope) => exists(
    db.select({ id: t.members.userId }).from(t.members).innerJoin(t.projects, eq(t.projects.workspaceId, t.members.workspaceId)).where(and(
      eq(t.projects.id, scope.projectId), eq(t.projects.workspaceId, scope.workspaceId), eq(t.members.userId, scope.actorUserId),
      scope.minimumRole === 'owner' ? eq(t.members.role, 'owner') : inArray(t.members.role, ['editor', 'owner']),
    )),
  );
  const sourceProjectMatches = exists(
    db
      .select({ id: t.projects.id })
      .from(t.projects)
      .where(
        and(
          eq(t.projects.id, t.notepads.projectId),
          eq(t.projects.workspaceId, t.notepads.workspaceId),
        ),
      ),
  );
  return {
    async listByProject(scope: ProjectScope): Promise<Notepad[]> {
      // Tree metadata only: live `notepad`-kind rows. Soft-deleted rows are
      // served by listDeletedByProject; card bodies never appear in the tree.
      const rows = await db
        .select()
        .from(t.notepads)
        .where(
          and(
            eq(t.notepads.workspaceId, scope.workspaceId),
            eq(t.notepads.projectId, scope.projectId),
            eq(t.notepads.kind, 'notepad'),
            isNull(t.notepads.deletedAt),
            sourceProjectMatches,
          ),
        )
        .orderBy(asc(t.notepads.position));
      return rows.map(mapNotepad);
    },

    async findByIdInScope(scope: ProjectScope, id: string): Promise<Notepad | null> {
      const [row] = await db
        .select()
        .from(t.notepads)
        .where(
          and(
            eq(t.notepads.id, id),
            eq(t.notepads.workspaceId, scope.workspaceId),
            eq(t.notepads.projectId, scope.projectId),
            sourceProjectMatches,
          ),
        );
      return row ? mapNotepad(row) : null;
    },

    async create(data: CreateNotepadData, scope: NotepadMutationScope): Promise<boolean> {
      if (data.workspaceId !== scope.workspaceId || data.projectId !== scope.projectId) return false;
      const stmt = sql`INSERT INTO notepads (id, workspace_id, project_id, parent_id, kind, title, content, version, position, is_favorite, created_by, created_at, updated_at)
        SELECT ${data.id}, ${data.workspaceId}, ${data.projectId}, ${data.parentId ?? null}, ${data.kind}, ${data.title}, ${data.content}, ${data.version}, ${data.position}, ${data.isFavorite ? 1 : 0}, ${data.createdBy}, ${data.createdAt}, ${data.updatedAt}
        WHERE ${writable(scope)}`;
      await runBatch(db, [db.run(stmt), db.run(sql`INSERT INTO notepads_fts (notepad_id, project_id, title, body) SELECT id, project_id, ${data.title}, '' FROM notepads WHERE id=${data.id} AND workspace_id=${scope.workspaceId} AND project_id=${scope.projectId} AND ${writable(scope)} AND deleted_at IS NULL`)]);
      return Boolean(await db.select({ id: t.notepads.id }).from(t.notepads).where(and(eq(t.notepads.id, data.id), eq(t.notepads.workspaceId, scope.workspaceId), eq(t.notepads.projectId, scope.projectId))).limit(1).then((rows) => rows.length));
    },

    async update(id: string, data: UpdateNotepadData, scope: NotepadMutationScope): Promise<boolean> {
      const result = await db.update(t.notepads).set(data).where(and(eq(t.notepads.id, id), eq(t.notepads.workspaceId, scope.workspaceId), eq(t.notepads.projectId, scope.projectId), isNull(t.notepads.deletedAt), eq(t.notepads.kind, 'notepad'), writable(scope))).returning({ id: t.notepads.id });
      return result.length > 0;
    },

    async move(id: string, parentId: string | null, position: string, scope: NotepadMutationScope): Promise<boolean> {
      const rows = await db
        .update(t.notepads)
        .set({ parentId, position, updatedAt: Date.now() })
        .where(and(eq(t.notepads.id, id), eq(t.notepads.workspaceId, scope.workspaceId), eq(t.notepads.projectId, scope.projectId), isNull(t.notepads.deletedAt), eq(t.notepads.kind, 'notepad'), writable(scope))).returning({ id: t.notepads.id });
      return rows.length > 0;
    },

    async softDelete(id: string, deletedAt: number, scope: NotepadMutationScope): Promise<boolean> {
      const [root] = await db
        .select({ deletedAt: t.notepads.deletedAt })
        .from(t.notepads)
        .where(and(eq(t.notepads.id, id), eq(t.notepads.workspaceId, scope.workspaceId), eq(t.notepads.projectId, scope.projectId), sourceProjectMatches, writable(scope)));
      if (!root || root.deletedAt !== null) return false;

      const descendants = await getDescendantIds(db, id);
      const allIds = [id, ...descendants];
      const now = deletedAt;
      const deletionOperationId = crypto.randomUUID();

      const statements: BatchItem<'sqlite'>[] = [];
      for (const chunk of chunkByParamBudget(allIds, 1, 3)) {
        statements.push(
          db
            .update(t.notepads)
            .set({ deletedAt: now, deletionOperationId, updatedAt: now })
            .where(and(inArray(t.notepads.id, chunk), eq(t.notepads.workspaceId, scope.workspaceId), eq(t.notepads.projectId, scope.projectId), isNull(t.notepads.deletedAt), writable(scope))),
        );
      }

      for (const chunk of chunkByParamBudget(allIds, 1, 0)) {
        statements.push(
          db.run(sql`DELETE FROM notepads_fts WHERE notepad_id IN ${chunk} AND EXISTS (SELECT 1 FROM projects p JOIN members m ON m.workspace_id=p.workspace_id WHERE p.id=${scope.projectId} AND p.workspace_id=${scope.workspaceId} AND m.user_id=${scope.actorUserId} AND m.role IN ('editor','owner'))`),
          db.delete(t.editLocks).where(and(inArray(t.editLocks.notepadId, chunk), writable(scope))),
        );
      }

      statements.unshift(db.update(t.notepads).set({ updatedAt: t.notepads.updatedAt }).where(and(eq(t.notepads.id, id), eq(t.notepads.workspaceId, scope.workspaceId), eq(t.notepads.projectId, scope.projectId), isNull(t.notepads.deletedAt), writable(scope))).returning({ id: t.notepads.id }));
      // Execute in a single atomic batch if there are updates to apply (Cloudflare D1 batch duration limit: 30s)
      if (statements.length > 0) {
        const result = await runBatch(db, statements);
        return batchDidWrite(result);
      }
      return false;
    },

    async restore(id: string, deleteTimestamp: number, scope: NotepadMutationScope): Promise<RestoredNotepad[] | null> {
      const [notepad] = await db
        .select()
        .from(t.notepads)
        .where(and(eq(t.notepads.id, id), eq(t.notepads.workspaceId, scope.workspaceId), eq(t.notepads.projectId, scope.projectId), sourceProjectMatches));
      if (!notepad || notepad.deletedAt !== deleteTimestamp) return [];
      const [member] = await db.select({ userId: t.members.userId }).from(t.members).where(and(eq(t.members.workspaceId, scope.workspaceId), eq(t.members.userId, scope.actorUserId), writable(scope)));
      if (!member) return null;

      const matchingNotepads = await db
        .select({
          id: t.notepads.id,
          parentId: t.notepads.parentId,
          title: t.notepads.title,
          content: t.notepads.content,
          projectId: t.notepads.projectId,
        })
        .from(t.notepads)
        .where(
          and(
            eq(t.notepads.workspaceId, notepad.workspaceId),
            eq(t.notepads.projectId, notepad.projectId),
            isNotNull(t.notepads.deletedAt),
            notepad.deletionOperationId
              ? eq(t.notepads.deletionOperationId, notepad.deletionOperationId)
              : eq(t.notepads.deletedAt, deleteTimestamp),
          ),
        );

      if (!notepad.deletionOperationId && matchingNotepads.length > 1) {
        throw new Error('ambiguous_delete_group');
      }

      let newParentId = notepad.parentId;
      let newPosition: string | null = null;
      if (notepad.parentId) {
        const [parent] = await db
          .select({ deletedAt: t.notepads.deletedAt })
          .from(t.notepads)
          .where(
            and(
              eq(t.notepads.id, notepad.parentId),
              eq(t.notepads.projectId, notepad.projectId),
              eq(t.notepads.workspaceId, notepad.workspaceId),
            ),
          );
        if (!parent || parent.deletedAt !== null) {
          newParentId = null;
          newPosition = await getLastRootPosition(db, {
            workspaceId: notepad.workspaceId,
            projectId: notepad.projectId,
          });
        }
      }

      const now = Date.now();
      const matchingIds = matchingNotepads.map((n) => n.id);

      const statements: BatchItem<'sqlite'>[] = [];
      for (const chunk of chunkByParamBudget(matchingIds, 1, 3)) {
        statements.push(
          db
            .update(t.notepads)
            .set({ deletedAt: null, deletionOperationId: null, updatedAt: now })
            .where(and(inArray(t.notepads.id, chunk), eq(t.notepads.workspaceId, scope.workspaceId), eq(t.notepads.projectId, scope.projectId), writable(scope))),
        );
      }

      if (newParentId !== notepad.parentId || newPosition !== null) {
        statements.push(
          db
            .update(t.notepads)
            .set({
              parentId: newParentId,
              position: newPosition ?? notepad.position,
              updatedAt: now,
            })
            .where(and(eq(t.notepads.id, id), eq(t.notepads.workspaceId, scope.workspaceId), eq(t.notepads.projectId, scope.projectId), writable(scope))),
        );
      }

      // Delete existing FTS rows for matchingIds first so re-running restore is idempotent
      for (const chunk of chunkByParamBudget(matchingIds, 1, 0)) {
        statements.push(db.run(sql`DELETE FROM notepads_fts WHERE notepad_id IN ${chunk} AND EXISTS (SELECT 1 FROM projects p JOIN members m ON m.workspace_id=p.workspace_id WHERE p.id=${scope.projectId} AND p.workspace_id=${scope.workspaceId} AND m.user_id=${scope.actorUserId} AND m.role IN ('editor','owner'))`));
      }

      for (const item of matchingNotepads) {
        statements.push(
          db.run(sql`INSERT INTO notepads_fts (notepad_id, project_id, title, body) SELECT id, project_id, ${item.title}, ${extractPlainText(item.content)} FROM notepads WHERE id=${item.id} AND deleted_at IS NULL AND EXISTS (SELECT 1 FROM projects p JOIN members m ON m.workspace_id=p.workspace_id WHERE p.id=${scope.projectId} AND p.workspace_id=${scope.workspaceId} AND m.user_id=${scope.actorUserId} AND m.role IN ('editor','owner'))`),
        );
      }

      statements.unshift(db.update(t.notepads).set({ updatedAt: t.notepads.updatedAt }).where(and(eq(t.notepads.id, id), eq(t.notepads.workspaceId, scope.workspaceId), eq(t.notepads.projectId, scope.projectId), eq(t.notepads.deletedAt, deleteTimestamp), writable(scope))).returning({ id: t.notepads.id }));
      // Execute in a single atomic batch if there are updates to apply (Cloudflare D1 batch duration limit: 30s)
      if (statements.length > 0) {
        const result = await runBatch(db, statements);
        if (!batchDidWrite(result)) return null;
      }

      return matchingNotepads.map((n) => ({
        id: n.id,
        parentId: n.parentId,
        title: n.title,
        content: n.content,
        projectId: n.projectId,
      }));
    },

    async hardDelete(id: string, scope: NotepadMutationScope): Promise<HardDeletedNotepad[] | null> {
      const [notepad] = await db
        .select()
        .from(t.notepads)
        .where(and(eq(t.notepads.id, id), eq(t.notepads.workspaceId, scope.workspaceId), eq(t.notepads.projectId, scope.projectId), isNotNull(t.notepads.deletedAt), sourceProjectMatches));
      if (!notepad) return [];
      const [member] = await db.select({ userId: t.members.userId }).from(t.members).where(and(eq(t.members.workspaceId, scope.workspaceId), eq(t.members.userId, scope.actorUserId), writable(scope)));
      if (!member) return null;

      const descendants = await getDescendantIds(db, id);
      const allIds = [id, ...descendants];
      const foreignChildren = await db
        .select({ id: t.notepads.id })
        .from(t.notepads)
        .where(
          and(
            inArray(t.notepads.parentId, allIds),
            or(
              ne(t.notepads.projectId, notepad.projectId),
              ne(t.notepads.workspaceId, notepad.workspaceId),
            ),
          ),
        );
      if (foreignChildren.length > 0) {
        throw new Error('tree_scope_conflict');
      }

      const allRows: { id: string; coverKey: string | null }[] = [];
      for (const chunk of chunkInList(allIds)) {
        const rows = await db
          .select({ id: t.notepads.id, coverKey: t.notepads.coverKey })
          .from(t.notepads)
          .where(inArray(t.notepads.id, chunk));
        allRows.push(...rows);
      }

      const statements: BatchItem<'sqlite'>[] = [db.update(t.notepads).set({ updatedAt: t.notepads.updatedAt }).where(and(eq(t.notepads.id, id), eq(t.notepads.workspaceId, scope.workspaceId), eq(t.notepads.projectId, scope.projectId), isNotNull(t.notepads.deletedAt), writable(scope))).returning({ id: t.notepads.id })];
      for (const chunk of chunkByParamBudget(allIds, 1, 0)) {
        statements.push(
          db.run(sql`DELETE FROM notepads_fts WHERE notepad_id IN ${chunk} AND EXISTS (SELECT 1 FROM projects p JOIN members m ON m.workspace_id=p.workspace_id WHERE p.id=${scope.projectId} AND p.workspace_id=${scope.workspaceId} AND m.user_id=${scope.actorUserId} AND m.role='owner')`),
          db.run(sql`DELETE FROM notepad_links WHERE target_id IN ${chunk} AND EXISTS (SELECT 1 FROM projects p JOIN members m ON m.workspace_id=p.workspace_id WHERE p.id=${scope.projectId} AND p.workspace_id=${scope.workspaceId} AND m.user_id=${scope.actorUserId} AND m.role='owner')`),
          db.delete(t.notepads).where(and(inArray(t.notepads.id, chunk), eq(t.notepads.workspaceId, scope.workspaceId), eq(t.notepads.projectId, scope.projectId), writable(scope))),
        );
      }

      // Execute in a single atomic batch if there are updates to apply (Cloudflare D1 batch duration limit: 30s)
      if (statements.length > 0) {
        const result = await runBatch(db, statements);
        if (!batchDidWrite(result)) return null;
      }

      return allRows.map((r) => ({ id: r.id, coverKey: r.coverKey }));
    },

    async countByCoverKey(coverKey: string, excludeNotepadId?: string): Promise<number> {
      const conditions = [eq(t.notepads.coverKey, coverKey)];
      if (excludeNotepadId) {
        conditions.push(ne(t.notepads.id, excludeNotepadId));
      }
      const [row] = await db
        .select({ count: count() })
        .from(t.notepads)
        .where(and(...conditions));
      return Number(row?.count ?? 0);
    },

    // Content & versioning
    async getContent(scope: ProjectScope, id: string): Promise<NotepadContent | null> {
      const [row] = await db
        .select({
          id: t.notepads.id,
          workspaceId: t.notepads.workspaceId,
          projectId: t.notepads.projectId,
          title: t.notepads.title,
          content: t.notepads.content,
          version: t.notepads.version,
        })
        .from(t.notepads)
        .where(and(
          eq(t.notepads.id, id),
          eq(t.notepads.workspaceId, scope.workspaceId),
          eq(t.notepads.projectId, scope.projectId),
          sourceProjectMatches,
        ));
      return row ?? null;
    },

    async saveContentBatch(args: SaveContentBatchArgs): Promise<number> {
      if (contentByteLength(args.content) > MAX_CONTENT_BYTES) {
        throw new Error('content_too_large');
      }

      const { row, content, baseVersion, actorId, validLinks, previousLinks, now, lock } = args;
      const newVersion = baseVersion + 1;
      const actorAllowed = sql`EXISTS (SELECT 1 FROM projects p JOIN members m ON m.workspace_id = p.workspace_id
        WHERE p.id = ${args.scope.projectId} AND p.workspace_id = ${args.scope.workspaceId} AND m.user_id = ${args.scope.actorUserId} AND m.role IN ('editor', 'owner'))`;
      const cond = sql`(${liveContentCond(row.id, newVersion, content)}) AND ${actorAllowed} AND EXISTS (
        SELECT 1 FROM notepads n JOIN projects p ON p.id = n.project_id AND p.workspace_id = n.workspace_id WHERE n.id = ${row.id} AND n.workspace_id = ${row.workspaceId} AND n.project_id = ${row.projectId}
      )`;
      const condParams = LIVE_CONTENT_COND_PARAMS + 3;
      const plain = extractPlainText(content);
      const { added, removed } = diffLinks(previousLinks, validLinks);
      const lockAllowed = sql`NOT EXISTS (
        SELECT 1 FROM edit_locks WHERE notepad_id = ${row.id} AND expires_at > ${now}
        ${lock ? sql`AND (user_id <> ${actorId} OR client_id <> ${lock.clientId})` : sql``}
      )`;

      const statements: BatchItem<'sqlite'>[] = [
        db
          .update(t.notepads)
          .set({
            // A lock acquired after the service's early check must fail in the
            // same CAS statement. Preserve version-conflict precedence.
            content: sql`CASE WHEN ${t.notepads.version} <> ${baseVersion}
              THEN ${t.notepads.content} WHEN ${lockAllowed} THEN ${content} END`,
            // A stale write must fail inside the batch, before any side effects.
            // The NOT NULL constraint rolls back the transaction on a missed CAS.
            version: sql`CASE WHEN ${t.notepads.version} = ${baseVersion}
              THEN ${t.notepads.version} + 1 END`,
            updatedAt: now,
          })
          .where(
            and(
              eq(t.notepads.id, row.id),
              eq(t.notepads.workspaceId, row.workspaceId),
              eq(t.notepads.projectId, row.projectId),
              isNull(t.notepads.deletedAt),
              writable(args.scope),
            ),
          )
          .returning({ version: t.notepads.version }),
        db.run(ftsDeleteStmt(row.id, cond)),
        db.run(ftsInsertStmt(row.id, row.title, plain, cond)),
      ];

      const addedUserIds = added.filter((l) => l.targetType === 'user').map((l) => l.targetId);
      if (addedUserIds.length > 0) {
        statements.push(
          ...mentionNotificationStatements(db, {
            workspaceId: row.workspaceId,
            notepadId: row.id,
            actorId,
            addedUserIds,
            cond,
            condParams,
            now,
          }),
        );
      }

      if (removed.length > 0 || added.length > 0) {
        statements.push(
          ...linkDeleteStatements(db, {
            sourceId: row.id,
            removed,
            cond,
            condParams,
          }),
          ...linkInsertStatements(db, {
            sourceId: row.id,
            added,
            cond,
            condParams,
          }),
        );
      }

      if (lock) {
        statements.push(
          db.run(sql`INSERT INTO edit_locks (notepad_id, user_id, client_id, expires_at)
            SELECT ${row.id}, ${actorId}, ${lock.clientId}, ${lock.expiresAt}
            WHERE ${cond}
            ON CONFLICT (notepad_id) DO UPDATE SET
              user_id = excluded.user_id, client_id = excluded.client_id,
              expires_at = excluded.expires_at
            WHERE edit_locks.expires_at <= ${now}
              OR (edit_locks.user_id = excluded.user_id AND edit_locks.client_id = excluded.client_id)`),
        );
      }

      let results: any[];
      try {
        results = (await runBatch(db, statements)) as any[];
      } catch (error) {
        if (
          error instanceof Error &&
          error.message.includes('NOT NULL constraint failed: notepads.content')
        ) {
          throw new Error('lock_conflict', { cause: error });
        }
        if (
          error instanceof Error &&
          error.message.includes('NOT NULL constraint failed: notepads.version')
        ) {
          throw new Error('version_conflict', { cause: error });
        }
        throw error;
      }
      const firstRes = results?.[0];
      const rows = firstRes?.results ?? (Array.isArray(firstRes) ? firstRes : []);
      if (!rows || rows.length === 0) {
        const [member] = await db.select({ role: t.members.role }).from(t.members).where(and(eq(t.members.workspaceId, args.scope.workspaceId), eq(t.members.userId, args.scope.actorUserId)));
        if (!member || member.role === 'viewer' || (args.scope.minimumRole === 'owner' && member.role !== 'owner')) throw new Error('workspace_write_forbidden');
        throw new Error('version_conflict');
      }
      return rows[0]?.version ?? newVersion;
    },

    async resolveReference(
      scope: ProjectScope,
      kind: ContentReferenceKind,
      id: string,
    ): Promise<ReferencePreview | null> {
      const targets = projectTargetQuery(db, scope, kind, [id]);
      if (kind === 'card') {
        const [row] = await db
          .select({
            id: t.cards.id,
            workspaceId: t.notepads.workspaceId,
            projectId: t.notepads.projectId,
            title: t.notepads.title,
            boardId: t.boards.id,
            boardName: t.boards.name,
            columnName: t.boardColumns.name,
            priority: t.cards.priority,
          })
          .from(t.cards)
          .innerJoin(t.notepads, eq(t.notepads.id, t.cards.notepadId))
          .innerJoin(t.boards, eq(t.boards.id, t.cards.boardId))
          .innerJoin(t.boardColumns, eq(t.boardColumns.id, t.cards.columnId))
          .where(inArray(t.cards.id, targets))
          .limit(1);
        return row ? { kind, ...row } : null;
      }
      const table = kind === 'notepad' ? t.notepads : t.boards;
      const [row] = await db
        .select({
          id: table.id,
          workspaceId: table.workspaceId,
          projectId: table.projectId,
          title: kind === 'notepad' ? t.notepads.title : t.boards.name,
          icon: table.icon,
        })
        .from(table)
        .where(inArray(table.id, targets))
        .limit(1);
      return row ? { kind, ...row } : null;
    },

    async filterProjectTargets(scope: ProjectScope, links: StoredLink[]): Promise<StoredLink[]> {
      return filterProjectTargets(db, scope, links);
    },

    // Tree navigation
    async getChildren(
      scope: ProjectScope,
      parentIds: string[],
    ): Promise<{ id: string; parentId: string | null }[]> {
      return getNotepadChildren(db, scope, parentIds, 'live');
    },

    async getParent(
      scope: ProjectScope,
      id: string,
    ): Promise<{ id: string; parentId: string | null } | null> {
      const [row] = await db
        .select({ id: t.notepads.id, parentId: t.notepads.parentId })
        .from(t.notepads)
        .where(
          and(
            eq(t.notepads.id, id),
            eq(t.notepads.workspaceId, scope.workspaceId),
            eq(t.notepads.projectId, scope.projectId),
          ),
        );
      return row ?? null;
    },

    // Tags
    async listTagIds(scope: ProjectScope, notepadId: string): Promise<string[]> {
      const rows = await db
        .select({ tagId: t.notepadTags.tagId })
        .from(t.notepadTags)
        .innerJoin(t.notepads, eq(t.notepads.id, t.notepadTags.notepadId))
        .innerJoin(
          t.projects,
          and(
            eq(t.projects.id, t.notepads.projectId),
            eq(t.projects.workspaceId, t.notepads.workspaceId),
          ),
        )
        .innerJoin(
          t.tags,
          and(eq(t.tags.id, t.notepadTags.tagId), eq(t.tags.projectId, t.notepads.projectId)),
        )
        .where(and(
          eq(t.notepadTags.notepadId, notepadId),
          eq(t.notepads.workspaceId, scope.workspaceId),
          eq(t.notepads.projectId, scope.projectId),
        ));
      return rows.map((r) => r.tagId);
    },

    async setTagIds(notepadId: string, tagIds: string[], scope: NotepadMutationScope): Promise<boolean> {
      const uniqueTagIds = [...new Set(tagIds)];
      const [note] = await db.select({ id: t.notepads.id }).from(t.notepads).where(and(eq(t.notepads.id, notepadId), eq(t.notepads.workspaceId, scope.workspaceId), eq(t.notepads.projectId, scope.projectId), isNull(t.notepads.deletedAt), writable(scope)));
      if (!note) return false;
      if (uniqueTagIds.length > 0) {
        const valid = await db.select({ id: t.tags.id }).from(t.tags).where(and(eq(t.tags.projectId, scope.projectId), inArray(t.tags.id, uniqueTagIds)));
        if (valid.length !== uniqueTagIds.length) return false;
      }
      const statements: BatchItem<'sqlite'>[] = [
        db.update(t.notepads).set({ updatedAt: t.notepads.updatedAt }).where(and(eq(t.notepads.id, notepadId), eq(t.notepads.workspaceId, scope.workspaceId), eq(t.notepads.projectId, scope.projectId), isNull(t.notepads.deletedAt), writable(scope))).returning({ id: t.notepads.id }),
        db.run(sql`DELETE FROM notepad_tags WHERE notepad_id=${notepadId} AND EXISTS (SELECT 1 FROM notepads n JOIN projects p ON p.id=n.project_id JOIN members m ON m.workspace_id=p.workspace_id WHERE n.id=${notepadId} AND n.workspace_id=${scope.workspaceId} AND n.project_id=${scope.projectId} AND m.user_id=${scope.actorUserId} AND m.role IN ('editor','owner'))`),
      ];
      if (uniqueTagIds.length > 0) {
        for (const tagId of uniqueTagIds) {
          statements.push(db.run(sql`INSERT INTO notepad_tags (notepad_id, tag_id) SELECT ${notepadId}, ${tagId} WHERE EXISTS (SELECT 1 FROM notepads n JOIN projects p ON p.id=n.project_id JOIN members m ON m.workspace_id=p.workspace_id WHERE n.id=${notepadId} AND n.workspace_id=${scope.workspaceId} AND n.project_id=${scope.projectId} AND m.user_id=${scope.actorUserId} AND m.role IN ('editor','owner'))`));
        }
      }
      return batchDidWrite(await runBatch(db, statements));
    },

    // Locks
    async getLock(scope: ProjectScope, notepadId: string): Promise<EditLock | null> {
      const [result] = await db
        .select({ lock: t.editLocks })
        .from(t.editLocks)
        .innerJoin(t.notepads, eq(t.notepads.id, t.editLocks.notepadId))
        .where(and(
          eq(t.editLocks.notepadId, notepadId),
          eq(t.notepads.workspaceId, scope.workspaceId),
          eq(t.notepads.projectId, scope.projectId),
          sourceProjectMatches,
        ));
      const row = result?.lock;
      return row
        ? {
            notepadId: row.notepadId,
            userId: row.userId,
            clientId: row.clientId,
            expiresAt: row.expiresAt,
          }
        : null;
    },

    async deleteLock(notepadId: string): Promise<void> {
      await db.delete(t.editLocks).where(eq(t.editLocks.notepadId, notepadId));
    },

    // FTS
    async deleteFts(notepadId: string): Promise<void> {
      await db.run(sql`DELETE FROM notepads_fts WHERE notepad_id = ${notepadId}`);
    },

    async insertFts(notepadId: string, title: string, body: string): Promise<void> {
      await db.run(ftsInsertNowStmt(notepadId, title, body));
    },

    // Links
    async listLinks(scope: ProjectScope, sourceId: string): Promise<StoredLink[]> {
      const rows = await db
        .select({ targetType: t.notepadLinks.targetType, targetId: t.notepadLinks.targetId })
        .from(t.notepadLinks)
        .innerJoin(t.notepads, eq(t.notepads.id, t.notepadLinks.sourceId))
        .where(and(
          eq(t.notepadLinks.sourceId, sourceId),
          eq(t.notepads.workspaceId, scope.workspaceId),
          eq(t.notepads.projectId, scope.projectId),
          sourceProjectMatches,
        ));
      return rows.map((r) => ({
        targetType: r.targetType as StoredLink['targetType'],
        targetId: r.targetId,
      }));
    },

    async listBacklinks(
      scope: ProjectScope,
      notepadId: string,
    ): Promise<Array<{ id: string; title: string; updatedAt: number }>> {
      const liveCardSource = db
        .select({ id: t.cards.id })
        .from(t.cards)
        .innerJoin(
          t.boards,
          and(
            eq(t.boards.id, t.cards.boardId),
            eq(t.boards.workspaceId, t.notepads.workspaceId),
            eq(t.boards.projectId, t.notepads.projectId),
          ),
        )
        .innerJoin(
          t.boardColumns,
          and(eq(t.boardColumns.id, t.cards.columnId), eq(t.boardColumns.boardId, t.boards.id)),
        )
        .where(and(eq(t.cards.notepadId, t.notepads.id), isNull(t.boards.deletedAt)));
      return db
        .select({
          id: t.notepads.id,
          title: t.notepads.title,
          updatedAt: t.notepads.updatedAt,
          icon: t.notepads.icon,
        })
        .from(t.notepadLinks)
        .innerJoin(t.notepads, eq(t.notepads.id, t.notepadLinks.sourceId))
        .innerJoin(
          t.projects,
          and(
            eq(t.projects.id, t.notepads.projectId),
            eq(t.projects.workspaceId, t.notepads.workspaceId),
          ),
        )
        .where(
          and(
            eq(t.notepadLinks.targetType, 'notepad'),
            inArray(t.notepadLinks.targetId, projectTargetQuery(db, scope, 'notepad', [notepadId])),
            eq(t.notepads.workspaceId, scope.workspaceId),
            eq(t.notepads.projectId, scope.projectId),
            isNull(t.notepads.deletedAt),
            or(eq(t.notepads.kind, 'notepad'), exists(liveCardSource)),
          ),
        );
    },

    // Position helpers
    async getLastChildPosition(scope: ProjectScope, parentId: string): Promise<string | null> {
      const [last] = await db
        .select({ position: t.notepads.position })
        .from(t.notepads)
        .where(and(eq(t.notepads.parentId, parentId), eq(t.notepads.workspaceId, scope.workspaceId), eq(t.notepads.projectId, scope.projectId), sourceProjectMatches, isNull(t.notepads.deletedAt), eq(t.notepads.kind, 'notepad')))
        .orderBy(desc(t.notepads.position))
        .limit(1);
      return last ? positionAfterLast(last.position) : null;
    },

    async getLastRootPosition(scope: ProjectScope): Promise<string | null> {
      return getLastRootPosition(db, scope);
    },

    async getLastRootNotepadPosition(scope: ProjectScope): Promise<string> {
      const [last] = await db
        .select({ position: t.notepads.position })
        .from(t.notepads)
        .where(
          and(
            eq(t.notepads.workspaceId, scope.workspaceId),
            eq(t.notepads.projectId, scope.projectId),
            sourceProjectMatches,
            isNull(t.notepads.parentId),
            isNull(t.notepads.deletedAt),
            eq(t.notepads.kind, 'notepad'),
          ),
        )
        .orderBy(desc(t.notepads.position))
        .limit(1);
      return positionAfterLast(last?.position ?? null);
    },

    // Search/suggest
    async findByPattern(
      scope: ProjectScope,
      pattern: string,
      limit: number,
    ): Promise<{ id: string; title: string; icon: string | null }[]> {
      const searchPattern = `%${pattern}%`;
      const rows = await db
        .select({ id: t.notepads.id, title: t.notepads.title, icon: t.notepads.icon })
        .from(t.notepads)
        .where(
          and(
            eq(t.notepads.workspaceId, scope.workspaceId),
            eq(t.notepads.projectId, scope.projectId),
            sourceProjectMatches,
            eq(t.notepads.kind, 'notepad'),
            isNull(t.notepads.deletedAt),
            sql`${t.notepads.title} LIKE ${searchPattern}`,
          ),
        )
        .orderBy(asc(t.notepads.title))
        .limit(limit);
      return rows.map((r) => ({ id: r.id, title: r.title, icon: r.icon }));
    },

    // Trash
    async listDeletedByProject(scope: ProjectScope): Promise<Notepad[]> {
      const rows = await db
        .select()
        .from(t.notepads)
        .where(
          and(
            eq(t.notepads.workspaceId, scope.workspaceId),
            eq(t.notepads.projectId, scope.projectId),
            sql`${t.notepads.deletedAt} IS NOT NULL`,
            sourceProjectMatches,
          ),
        )
        .orderBy(desc(t.notepads.deletedAt));
      return rows.map(mapNotepad);
    },
  };
}
async function getLastRootPosition(db: DB, scope: ProjectScope): Promise<string | null> {
  const [last] = await db
    .select({ position: t.notepads.position })
    .from(t.notepads)
    .where(
      and(
        eq(t.notepads.workspaceId, scope.workspaceId),
        eq(t.notepads.projectId, scope.projectId),
        exists(db.select({ id: t.projects.id }).from(t.projects).where(and(eq(t.projects.id, t.notepads.projectId), eq(t.projects.workspaceId, t.notepads.workspaceId)))),
        isNull(t.notepads.parentId),
        isNull(t.notepads.deletedAt),
        eq(t.notepads.kind, 'notepad'),
      ),
    )
    .orderBy(desc(t.notepads.position))
    .limit(1);
  return last ? positionAfterLast(last.position) : null;
}

function mapNotepad(row: typeof t.notepads.$inferSelect): Notepad {
  return {
    id: row.id,
    workspaceId: row.workspaceId,
    projectId: row.projectId,
    parentId: row.parentId,
    kind: row.kind,
    title: row.title,
    icon: row.icon,
    coverKey: row.coverKey,
    content: row.content,
    version: row.version,
    position: row.position,
    isFavorite: row.isFavorite,
    deletedAt: row.deletedAt ?? null,
    deletionOperationId: row.deletionOperationId ?? null,
    createdBy: row.createdBy,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

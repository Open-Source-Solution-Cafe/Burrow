import type { DB } from '../client';
import * as t from '../schema';
import { and, asc, desc, eq, inArray, isNull, sql } from 'drizzle-orm';
import type {
  IBoardRepository,
  Board,
  BoardColumn,
  BoardWithDetails,
  CreateBoardData,
  UpdateBoardData,
  CreateColumnData,
  UpdateColumnData,
  BoardMutationScope,
  ProjectScope,
} from '../../../../infrastructure/types';
import type { BatchItem } from 'drizzle-orm/batch';
import { runBatch } from '../lib/batch';
import { chunkByParamBudget, chunkInList } from '../../../../services/utils/chunk';
import { extractPlainText } from '../../../../../shared/extract';
import { boardInProjectScope } from '../../board-source';

const roleCheck = (scope: BoardMutationScope) => sql`exists (
  select 1 from members m
  where m.workspace_id = ${scope.workspaceId}
    and m.user_id = ${scope.actorUserId}
    and (${scope.minimumRole === 'owner' ? sql`m.role = 'owner'` : sql`m.role in ('owner', 'editor')`})
)`;

function batchSucceeded(result: unknown): boolean {
  return Boolean(
    Array.isArray(result) &&
      (result[0] as { results?: unknown[] } | undefined)?.results?.length,
  );
}

export function createBoardRepository(db: DB): IBoardRepository {
  const sourceProjectMatches = sql`exists (select 1 from projects where projects.id = ${t.boards.projectId} and projects.workspace_id = ${t.boards.workspaceId})`;
  return {
    async listByProject(scope: ProjectScope): Promise<Board[]> {
      const rows = await db
        .select()
        .from(t.boards)
        .where(
          and(
            eq(t.boards.projectId, scope.projectId),
            eq(t.boards.workspaceId, scope.workspaceId),
            isNull(t.boards.deletedAt),
            sourceProjectMatches,
          ),
        )
        .orderBy(asc(t.boards.position));
      return rows.map(mapBoard);
    },

    async findByIdInScope(scope: ProjectScope, id: string): Promise<Board | null> {
      const [row] = await db
        .select()
        .from(t.boards)
        .where(and(eq(t.boards.id, id), boardInProjectScope(scope, id)));
      return row ? mapBoard(row) : null;
    },

    async createWithColumns(data: CreateBoardData, columns: CreateColumnData[], scope: BoardMutationScope): Promise<boolean> {
      const statements: BatchItem<any>[] = [db.run(sql`INSERT INTO boards
        (id, workspace_id, project_id, name, icon, position, created_at, updated_at)
        SELECT ${data.id}, ${data.workspaceId}, ${data.projectId}, ${data.name}, ${data.icon ?? null},
          ${data.position}, ${data.createdAt}, ${data.updatedAt}
        WHERE ${roleCheck(scope)} AND ${data.workspaceId} = ${scope.workspaceId}
          AND EXISTS (SELECT 1 FROM projects p WHERE p.id = ${data.projectId} AND p.workspace_id = ${scope.workspaceId})
        RETURNING id`)];
      for (const column of columns) {
        statements.push(db.run(sql`INSERT INTO board_columns
          (id, board_id, name, color, position, wip_limit)
          SELECT ${column.id}, ${column.boardId}, ${column.name}, ${column.color ?? null}, ${column.position}, ${column.wipLimit ?? null}
          WHERE EXISTS (SELECT 1 FROM boards b WHERE b.id = ${data.id}
            AND b.workspace_id = ${scope.workspaceId} AND ${roleCheck(scope)})`));
      }
      return batchSucceeded(await runBatch(db, statements));
    },

    async updateGuarded(id: string, data: UpdateBoardData, scope: BoardMutationScope): Promise<boolean> {
      const rows = await db.all<{ id: string }>(sql`UPDATE boards SET
        name = CASE WHEN ${data.name !== undefined ? 1 : 0} THEN ${data.name ?? null} ELSE name END,
        icon = CASE WHEN ${data.icon !== undefined ? 1 : 0} THEN ${data.icon ?? null} ELSE icon END,
        updated_at = ${data.updatedAt}
        WHERE id = ${id} AND workspace_id = ${scope.workspaceId} AND deleted_at IS NULL
          AND ${roleCheck(scope)} AND ${sourceProjectMatches}
        RETURNING id`);
      return rows.length === 1;
    },

    async softDeleteGuarded(id: string, deletedAt: number, scope: BoardMutationScope): Promise<boolean> {
      const deletionOperationId = crypto.randomUUID();
      const statements: BatchItem<any>[] = [
        db.update(t.boards).set({ deletedAt, deletionOperationId, updatedAt: deletedAt }).where(and(
          eq(t.boards.id, id), eq(t.boards.workspaceId, scope.workspaceId), isNull(t.boards.deletedAt), sourceProjectMatches,
          sql`${roleCheck(scope)}`,
        )).returning({ id: t.boards.id }),
        db.run(sql`UPDATE notepads SET deleted_at = ${deletedAt}, deletion_operation_id = ${deletionOperationId}, updated_at = ${deletedAt}
          WHERE id IN (SELECT c.notepad_id FROM cards c
            JOIN boards b ON b.id = c.board_id
            JOIN projects p ON p.id = b.project_id AND p.workspace_id = b.workspace_id
            JOIN board_columns bc ON bc.id = c.column_id AND bc.board_id = c.board_id
            JOIN notepads n ON n.id = c.notepad_id AND n.project_id = p.id AND n.workspace_id = p.workspace_id AND n.kind = 'card'
            WHERE c.board_id = ${id} AND b.deleted_at = ${deletedAt} AND b.deletion_operation_id = ${deletionOperationId}
              AND b.workspace_id = ${scope.workspaceId}
              AND ${roleCheck(scope)} AND n.deleted_at IS NULL)`),
        db.run(sql`DELETE FROM notepads_fts WHERE notepad_id IN (SELECT c.notepad_id FROM cards c
          JOIN boards b ON b.id = c.board_id
          JOIN projects p ON p.id = b.project_id AND p.workspace_id = b.workspace_id
          JOIN board_columns bc ON bc.id = c.column_id AND bc.board_id = c.board_id
          JOIN notepads n ON n.id = c.notepad_id AND n.project_id = p.id AND n.workspace_id = p.workspace_id AND n.kind = 'card'
          WHERE c.board_id = ${id} AND b.deleted_at = ${deletedAt} AND b.deletion_operation_id = ${deletionOperationId}
            AND b.workspace_id = ${scope.workspaceId}
            AND ${roleCheck(scope)})`),
      ];

      return batchSucceeded(await runBatch(db, statements));
    },

    async restoreGuarded(id: string, scope: BoardMutationScope): Promise<boolean> {
      const [board] = await db
        .select({ deletedAt: t.boards.deletedAt, deletionOperationId: t.boards.deletionOperationId })
        .from(t.boards)
        .where(and(eq(t.boards.id, id), eq(t.boards.workspaceId, scope.workspaceId), sql`${roleCheck(scope)}`));
      if (!board) return false;
      const deleteTimestamp = board.deletedAt;
      const deletionOperationId = board.deletionOperationId;
      if (deleteTimestamp === null) return false;
      const now = Date.now();

      const cardCondition = and(
        eq(t.cards.boardId, id),
        deletionOperationId
          ? eq(t.notepads.deletionOperationId, deletionOperationId)
          : eq(t.notepads.deletedAt, deleteTimestamp),
        sql`exists (select 1 from boards b join projects p on p.id = b.project_id and p.workspace_id = b.workspace_id
          join board_columns bc on bc.id = cards.column_id and bc.board_id = cards.board_id
          where b.id = cards.board_id and notepads.project_id = p.id and notepads.workspace_id = p.workspace_id and notepads.kind = 'card')`,
      );

      const cards = await db
        .select({
          id: t.notepads.id,
          title: t.notepads.title,
          content: t.notepads.content,
        })
        .from(t.cards)
        .innerJoin(t.notepads, eq(t.notepads.id, t.cards.notepadId))
        .where(cardCondition);

      if (!deletionOperationId && cards.length > 0) {
        throw new Error('ambiguous_delete_group');
      }

      const boardConditions = [
        eq(t.boards.id, id),
        eq(t.boards.workspaceId, scope.workspaceId),
        eq(t.boards.deletedAt, deleteTimestamp),
        sql`${roleCheck(scope)}`,
      ];
      if (deletionOperationId) {
        boardConditions.push(eq(t.boards.deletionOperationId, deletionOperationId));
      }
      const statements: BatchItem<any>[] = [
        db.update(t.boards).set({ deletedAt: null, deletionOperationId: null, updatedAt: now }).where(and(...boardConditions)).returning({ id: t.boards.id }),
      ];
      if (deletionOperationId) {
        statements.push(db.run(sql`UPDATE notepads SET deleted_at = NULL, deletion_operation_id = NULL, updated_at = ${now}
          WHERE id IN (SELECT c.notepad_id FROM cards c
            JOIN boards b ON b.id = c.board_id
            JOIN projects p ON p.id = b.project_id AND p.workspace_id = b.workspace_id
            JOIN board_columns bc ON bc.id = c.column_id AND bc.board_id = c.board_id
            JOIN notepads n ON n.id = c.notepad_id AND n.project_id = p.id AND n.workspace_id = p.workspace_id AND n.kind = 'card'
            WHERE c.board_id = ${id} AND n.deletion_operation_id = ${deletionOperationId}
              AND EXISTS (SELECT 1 FROM boards authorized WHERE authorized.id = ${id}
                AND authorized.workspace_id = ${scope.workspaceId} AND authorized.deleted_at IS NULL
                AND ${roleCheck(scope)}))`));
      }

      if (cards.length > 0) {
        const restoredIds = cards.map((card) => card.id);
        for (const chunk of chunkByParamBudget(restoredIds, 1, 0)) {
          statements.push(db.run(sql`DELETE FROM notepads_fts WHERE notepad_id IN ${chunk}
            AND EXISTS (SELECT 1 FROM boards authorized WHERE authorized.id = ${id}
              AND authorized.workspace_id = ${scope.workspaceId} AND authorized.deleted_at IS NULL
              AND ${roleCheck(scope)})`));
        }
        for (const card of cards) {
          const plainText = extractPlainText(card.content);
          statements.push(
            db.run(
              sql`INSERT INTO notepads_fts(notepad_id, title, body)
                SELECT ${card.id}, ${card.title}, ${plainText}
                WHERE EXISTS (SELECT 1 FROM boards authorized WHERE authorized.id = ${id}
                  AND authorized.workspace_id = ${scope.workspaceId} AND authorized.deleted_at IS NULL
                  AND ${roleCheck(scope)})`,
            ),
          );
        }
      }

      // Execute in a single atomic batch (Cloudflare D1 batch duration limit: 30s)
      return batchSucceeded(await runBatch(db, statements));
    },

    async hardDeleteGuarded(id: string, scope: BoardMutationScope): Promise<boolean> {
      const statements: BatchItem<any>[] = [];
      const validCardBodies = sql`SELECT c.notepad_id FROM cards c
        JOIN boards b ON b.id = c.board_id
        JOIN projects p ON p.id = b.project_id AND p.workspace_id = b.workspace_id
        JOIN board_columns bc ON bc.id = c.column_id AND bc.board_id = c.board_id
        JOIN notepads n ON n.id = c.notepad_id AND n.project_id = p.id AND n.workspace_id = p.workspace_id AND n.kind = 'card'
        WHERE c.board_id = ${id} AND b.workspace_id = ${scope.workspaceId}
          AND b.deleted_at IS NOT NULL AND ${roleCheck(scope)}`;
      statements.push(
        db.run(sql`UPDATE boards SET updated_at = updated_at WHERE id = ${id}
          AND workspace_id = ${scope.workspaceId} AND deleted_at IS NOT NULL AND ${roleCheck(scope)}
          RETURNING id`),
        db.run(sql`DELETE FROM notepads_fts WHERE notepad_id IN (${validCardBodies})`),
        db.run(sql`DELETE FROM notepad_links WHERE target_type IN ('notepad', 'card') AND target_id IN (${validCardBodies})
          AND source_id IN (SELECT source.id FROM notepads source
            JOIN boards b ON b.id = ${id} AND b.workspace_id = ${scope.workspaceId}
            WHERE ${roleCheck(scope)}
              AND source.project_id = b.project_id AND source.workspace_id = b.workspace_id)`),
        db.run(sql`DELETE FROM notepads WHERE id IN (${validCardBodies}) AND EXISTS (
          SELECT 1 FROM boards b WHERE b.id = ${id} AND b.workspace_id = ${scope.workspaceId}
            AND b.deleted_at IS NOT NULL AND ${roleCheck(scope)})`),
      );
      statements.push(db.delete(t.boards).where(and(
        eq(t.boards.id, id), eq(t.boards.workspaceId, scope.workspaceId),
        sql`${t.boards.deletedAt} IS NOT NULL`, sql`${roleCheck(scope)}`,
      )).returning({ id: t.boards.id }));

      // Execute in a single atomic batch (Cloudflare D1 batch duration limit: 30s)
      return batchSucceeded(await runBatch(db, statements));
    },

    // Columns
    async listColumns(scope: ProjectScope, boardId: string): Promise<BoardColumn[]> {
      const rows = await db
        .select()
        .from(t.boardColumns)
        .where(and(eq(t.boardColumns.boardId, boardId), boardInProjectScope(scope, boardId)))
        .orderBy(asc(t.boardColumns.position));
      return rows.map(mapColumn);
    },

    async findColumnByIdInScope(scope: ProjectScope, columnId: string): Promise<BoardColumn | null> {
      const [row] = await db
        .select({ column: t.boardColumns })
        .from(t.boardColumns)
        .innerJoin(t.boards, eq(t.boards.id, t.boardColumns.boardId))
        .where(and(
          eq(t.boardColumns.id, columnId),
          isNull(t.boards.deletedAt),
          sourceProjectMatches,
          eq(t.boards.workspaceId, scope.workspaceId),
          eq(t.boards.projectId, scope.projectId),
        ));
      return row ? mapColumn(row.column) : null;
    },

    async createColumnGuarded(data: CreateColumnData, scope: BoardMutationScope): Promise<boolean> {
      const rows = await db.all<{ id: string }>(sql`INSERT INTO board_columns
        (id, board_id, name, color, position, wip_limit)
        SELECT ${data.id}, ${data.boardId}, ${data.name}, ${data.color ?? null}, ${data.position}, ${data.wipLimit ?? null}
        WHERE EXISTS (SELECT 1 FROM boards b WHERE b.id = ${data.boardId}
          AND b.workspace_id = ${scope.workspaceId} AND b.deleted_at IS NULL
          AND ${roleCheck(scope)} AND EXISTS (SELECT 1 FROM projects p WHERE p.id = b.project_id AND p.workspace_id = b.workspace_id))
        RETURNING id`);
      return rows.length === 1;
    },

    async updateColumnGuarded(id: string, data: UpdateColumnData, scope: BoardMutationScope): Promise<boolean> {
      const rows = await db.all<{ id: string }>(sql`UPDATE board_columns SET
        name = CASE WHEN ${data.name !== undefined ? 1 : 0} THEN ${data.name ?? null} ELSE name END,
        color = CASE WHEN ${data.color !== undefined ? 1 : 0} THEN ${data.color ?? null} ELSE color END,
        wip_limit = CASE WHEN ${data.wipLimit !== undefined ? 1 : 0} THEN ${data.wipLimit ?? null} ELSE wip_limit END
        WHERE id = ${id} AND EXISTS (SELECT 1 FROM boards b WHERE b.id = board_id
          AND b.workspace_id = ${scope.workspaceId} AND b.deleted_at IS NULL
          AND ${roleCheck(scope)} AND EXISTS (SELECT 1 FROM projects p WHERE p.id = b.project_id AND p.workspace_id = b.workspace_id))
        RETURNING id`);
      return rows.length === 1;
    },

    async moveColumnGuarded(id: string, position: string, scope: BoardMutationScope): Promise<boolean> {
      const rows = await db.all<{ id: string }>(sql`UPDATE board_columns SET position = ${position}
        WHERE id = ${id} AND EXISTS (SELECT 1 FROM boards b WHERE b.id = board_id
          AND b.workspace_id = ${scope.workspaceId} AND b.deleted_at IS NULL
          AND ${roleCheck(scope)} AND EXISTS (SELECT 1 FROM projects p WHERE p.id = b.project_id AND p.workspace_id = b.workspace_id))
        RETURNING id`);
      return rows.length === 1;
    },

    async deleteColumnGuarded(id: string, moveToColumnId: string | null, scope: BoardMutationScope): Promise<boolean> {
      const source = await db.select({ boardId: t.boardColumns.boardId }).from(t.boardColumns).where(eq(t.boardColumns.id, id));
      const boardId = source[0]?.boardId;
      if (!boardId) return false;
      const destinationCondition = moveToColumnId
        ? sql`exists (select 1 from board_columns dest where dest.id = ${moveToColumnId} and dest.board_id = ${boardId})`
        : sql`not exists (select 1 from cards c where c.column_id = ${id})`;
      const statements: BatchItem<any>[] = [
        db.run(sql`UPDATE board_columns SET position = position WHERE id = ${id}
          AND EXISTS (SELECT 1 FROM boards b WHERE b.id = ${boardId} AND b.workspace_id = ${scope.workspaceId}
            AND b.deleted_at IS NULL AND ${roleCheck(scope)}
            AND EXISTS (SELECT 1 FROM projects p WHERE p.id = b.project_id AND p.workspace_id = b.workspace_id))
          AND ${destinationCondition} RETURNING id`),
      ];
      if (moveToColumnId) {
        statements.push(db.run(sql`UPDATE cards SET column_id = ${moveToColumnId}
          WHERE column_id = ${id} AND EXISTS (SELECT 1 FROM board_columns dest WHERE dest.id = ${moveToColumnId} AND dest.board_id = ${boardId})
            AND EXISTS (SELECT 1 FROM boards b WHERE b.id = ${boardId} AND b.workspace_id = ${scope.workspaceId}
              AND b.deleted_at IS NULL AND ${roleCheck(scope)}
              AND EXISTS (SELECT 1 FROM projects p WHERE p.id = b.project_id AND p.workspace_id = b.workspace_id))`));
      }
      statements.push(db.run(sql`DELETE FROM board_columns WHERE id = ${id} AND board_id = ${boardId}
        AND ${destinationCondition} AND NOT EXISTS (SELECT 1 FROM cards c WHERE c.column_id = ${id})
        AND EXISTS (SELECT 1 FROM boards b WHERE b.id = ${boardId} AND b.workspace_id = ${scope.workspaceId}
          AND b.deleted_at IS NULL AND ${roleCheck(scope)}
          AND EXISTS (SELECT 1 FROM projects p WHERE p.id = b.project_id AND p.workspace_id = b.workspace_id))
        RETURNING id`));
      return batchSucceeded(await runBatch(db, statements));
    },

    async getBoardWithDetails(
      scope: ProjectScope,
      boardId: string,
    ): Promise<BoardWithDetails | null> {
      const [board] = await db
        .select()
        .from(t.boards)
        .where(
          and(
            eq(t.boards.id, boardId),
            eq(t.boards.workspaceId, scope.workspaceId),
            eq(t.boards.projectId, scope.projectId),
            sourceProjectMatches,
            isNull(t.boards.deletedAt),
          ),
        );

      if (!board) return null;

      const columns = await db
        .select()
        .from(t.boardColumns)
        .where(eq(t.boardColumns.boardId, boardId))
        .orderBy(asc(t.boardColumns.position));

      const cardsWithNotepads = await db
        .select({
          id: t.cards.id,
          boardId: t.cards.boardId,
          columnId: t.cards.columnId,
          notepadId: t.cards.notepadId,
          title: t.notepads.title,
          position: t.cards.position,
          priority: t.cards.priority,
          dueDate: t.cards.dueDate,
          createdAt: t.cards.createdAt,
        })
        .from(t.cards)
        .innerJoin(t.notepads, eq(t.notepads.id, t.cards.notepadId))
        .innerJoin(
          t.boardColumns,
          and(eq(t.boardColumns.id, t.cards.columnId), eq(t.boardColumns.boardId, t.cards.boardId)),
        )
        .where(
          and(
            eq(t.cards.boardId, boardId),
            eq(t.notepads.workspaceId, scope.workspaceId),
            eq(t.notepads.projectId, scope.projectId),
            eq(t.notepads.kind, 'card'),
            isNull(t.notepads.deletedAt),
          ),
        )
        .orderBy(asc(t.cards.position));

      const cardIds = cardsWithNotepads.map((c) => c.id);
      const assignees: { cardId: string; userId: string; name: string; image: string | null }[] =
        [];
      if (cardIds.length > 0) {
        for (const chunk of chunkInList(cardIds, 1)) {
          const rows = await db
            .select({
              cardId: t.cardAssignees.cardId,
              userId: t.cardAssignees.userId,
              name: t.user.name,
              image: t.user.image,
            })
            .from(t.cardAssignees)
            .innerJoin(t.user, eq(t.user.id, t.cardAssignees.userId))
            .innerJoin(
              t.members,
              and(
                eq(t.members.userId, t.cardAssignees.userId),
                eq(t.members.workspaceId, scope.workspaceId),
              ),
            )
            .where(inArray(t.cardAssignees.cardId, chunk));
          assignees.push(...rows);
        }
      }

      const assigneesByCard = new Map<
        string,
        Array<{ userId: string; name: string; image: string | null }>
      >();
      for (const a of assignees) {
        const list = assigneesByCard.get(a.cardId) || [];
        list.push({ userId: a.userId, name: a.name, image: a.image });
        assigneesByCard.set(a.cardId, list);
      }

      const notepadIds = cardsWithNotepads.map((c) => c.notepadId);
      const tags: { notepadId: string; tagId: string; name: string; color: string | null }[] = [];
      if (notepadIds.length > 0) {
        for (const chunk of chunkInList(notepadIds, 1)) {
          const rows = await db
            .select({
              notepadId: t.notepadTags.notepadId,
              tagId: t.tags.id,
              name: t.tags.name,
              color: t.tags.color,
            })
            .from(t.notepadTags)
            .innerJoin(t.tags, eq(t.tags.id, t.notepadTags.tagId))
            .where(
              and(inArray(t.notepadTags.notepadId, chunk), eq(t.tags.projectId, board.projectId)),
            );
          tags.push(...rows);
        }
      }

      const tagsByNotepad = new Map<
        string,
        Array<{ id: string; name: string; color: string | null }>
      >();
      for (const tag of tags) {
        const list = tagsByNotepad.get(tag.notepadId) || [];
        list.push({ id: tag.tagId, name: tag.name, color: tag.color });
        tagsByNotepad.set(tag.notepadId, list);
      }

      const subtaskCounts: { cardId: string; total: number; completed: number }[] = [];
      if (cardIds.length > 0) {
        for (const chunk of chunkInList(cardIds)) {
          const rows = await db
            .select({
              cardId: t.cardSubtasks.cardId,
              total: sql<number>`count(*)`,
              completed: sql<number>`coalesce(sum(case when ${t.cardSubtasks.completed} then 1 else 0 end), 0)`,
            })
            .from(t.cardSubtasks)
            .where(inArray(t.cardSubtasks.cardId, chunk))
            .groupBy(t.cardSubtasks.cardId);
          subtaskCounts.push(...rows);
        }
      }

      const subtasksByCard = new Map<string, { total: number; completed: number }>();
      for (const row of subtaskCounts) {
        subtasksByCard.set(row.cardId, {
          total: Number(row.total),
          completed: Number(row.completed),
        });
      }

      const cardsByColumn = new Map<string, any[]>();
      for (const card of cardsWithNotepads) {
        const cardAssignees = assigneesByCard.get(card.id) || [];
        const cardTags = tagsByNotepad.get(card.notepadId) || [];
        const subtaskProgress = subtasksByCard.get(card.id) || { total: 0, completed: 0 };
        const list = cardsByColumn.get(card.columnId) || [];
        list.push({
          id: card.id,
          columnId: card.columnId,
          notepadId: card.notepadId,
          title: card.title,
          position: card.position,
          priority: card.priority as any,
          dueDate: card.dueDate,
          createdAt: card.createdAt,
          assignees: cardAssignees,
          tags: cardTags,
          totalSubtasks: subtaskProgress.total,
          completedSubtasks: subtaskProgress.completed,
        });
        cardsByColumn.set(card.columnId, list);
      }

      return {
        ...mapBoard(board),
        columns: columns.map((col) => ({
          ...mapColumn(col),
          cards: cardsByColumn.get(col.id) || [],
        })),
      };
    },

    // Trash
    async listDeletedByProject(scope: ProjectScope): Promise<Board[]> {
      const rows = await db
        .select()
        .from(t.boards)
        .where(
          and(
            eq(t.boards.projectId, scope.projectId),
            eq(t.boards.workspaceId, scope.workspaceId),
            sql`${t.boards.deletedAt} IS NOT NULL`,
            sourceProjectMatches,
          ),
        )
        .orderBy(desc(t.boards.deletedAt));
      return rows.map(mapBoard);
    },
  };
}

function mapBoard(row: typeof t.boards.$inferSelect): Board {
  return {
    id: row.id,
    workspaceId: row.workspaceId,
    projectId: row.projectId,
    name: row.name,
    icon: row.icon,
    position: row.position,
    deletedAt: row.deletedAt ?? null,
    deletionOperationId: row.deletionOperationId ?? null,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function mapColumn(row: typeof t.boardColumns.$inferSelect): BoardColumn {
  return {
    id: row.id,
    boardId: row.boardId,
    name: row.name,
    color: row.color,
    position: row.position,
    wipLimit: row.wipLimit ?? null,
  };
}

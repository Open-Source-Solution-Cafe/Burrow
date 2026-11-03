import { cardInProjectScope, cardSourceAgreement, liveCardSource } from '../../card-source';
import type { DB } from '../client';
import * as t from '../schema';
import { and, asc, desc, eq, inArray, isNull, sql } from 'drizzle-orm';
import type { BatchItem } from 'drizzle-orm/batch';
import { runBatch } from '../lib/batch';
import { chunkByParamBudget, chunkInList } from '../../../../services/utils/chunk';
import { cardCreationRows } from '../../../../entities/card';
import { ftsInsertNowStmt } from '../lib/search';
import type {
  ICardRepository,
  Card,
  CardMutationScope,
  CommentDeleteResult,
  CreateCommentMutation,
  UpdateCardMutation,
  CardSubtask,
  CreateSubtaskData,
  UpdateSubtaskData,
  CardAssignee,
  MyTasksFilters,
  MyTaskItem,
  CardSummary,
  ProjectScope,
  Comment,
  CardPriority,
  CardWithDetails,
  CardPlan,
} from '../../../../infrastructure/types';

const memberRole = (scope: CardMutationScope) => sql`EXISTS (
  SELECT 1 FROM members m WHERE m.workspace_id = ${scope.workspaceId}
    AND m.user_id = ${scope.actorUserId}
    AND (${scope.minimumRole === 'owner' ? sql`m.role = 'owner'` : sql`m.role IN ('owner', 'editor')`})
)`;

const cardInScope = (scope: CardMutationScope, cardId: string) => sql`EXISTS (
  SELECT 1 FROM cards c
  JOIN boards b ON b.id = c.board_id
  JOIN projects p ON p.id = b.project_id
  JOIN board_columns col ON col.id = c.column_id AND col.board_id = c.board_id
  JOIN notepads n ON n.id = c.notepad_id
  WHERE c.id = ${cardId} AND p.workspace_id = ${scope.workspaceId}
    AND b.workspace_id = p.workspace_id AND n.workspace_id = p.workspace_id
    AND n.project_id = p.id AND n.kind = 'card' AND b.deleted_at IS NULL
    AND n.deleted_at IS NULL AND ${memberRole(scope)}
)`;

function batchSucceeded(result: unknown): boolean {
  return Boolean(
    Array.isArray(result) &&
      (result[0] as { results?: unknown[] } | undefined)?.results?.length,
  );
}

export function createCardRepository(db: DB): ICardRepository {
  return {
    async createFromPlan(plan: CardPlan): Promise<boolean> {
      const rows = cardCreationRows(plan);
      const scope: CardMutationScope = {
        workspaceId: plan.workspaceId,
        actorUserId: plan.actorId,
        minimumRole: 'editor',
      };
      const body = rows.notepads.find((row) => row.id === plan.notepadId)!;
      const guardedBody = db.run(sql`INSERT INTO notepads
        (id, workspace_id, project_id, parent_id, kind, title, content, version, position,
         is_favorite, created_by, created_at, updated_at)
        SELECT ${body.id}, ${body.workspaceId}, ${body.projectId}, ${body.parentId}, ${body.kind},
          ${body.title}, ${body.content}, ${body.version}, ${body.position}, ${body.isFavorite ? 1 : 0},
          ${body.createdBy}, ${body.createdAt}, ${body.updatedAt}
        WHERE ${memberRole(scope)}
          AND EXISTS (SELECT 1 FROM projects p WHERE p.id = ${plan.projectId} AND p.workspace_id = ${plan.workspaceId})
          AND EXISTS (SELECT 1 FROM boards b JOIN board_columns col ON col.board_id = b.id
            WHERE b.id = ${plan.boardId} AND b.project_id = ${plan.projectId}
              AND b.workspace_id = ${plan.workspaceId} AND b.deleted_at IS NULL
              AND col.id = ${plan.columnId})
        RETURNING id`);
      const statements: BatchItem<'sqlite'>[] = [guardedBody, db.run(ftsInsertNowStmt(body.id, body.title, body.plainText))];
      for (const row of rows.notepads) {
        if (row.id === body.id) continue;
        statements.push(db.insert(t.notepads).values(row));
        statements.push(db.run(ftsInsertNowStmt(row.id, row.title, row.plainText)));
      }
      statements.push(db.insert(t.cards).values(rows.card));
      if (rows.links.length) statements.push(db.insert(t.notepadLinks).values(rows.links));
      for (const chunk of chunkByParamBudget(rows.assignees, 2)) {
        statements.push(db.insert(t.cardAssignees).values(chunk));
      }
      for (const chunk of chunkByParamBudget(rows.tags, 2)) {
        statements.push(db.insert(t.notepadTags).values(chunk));
      }
      for (const chunk of chunkByParamBudget(rows.notifications, 10)) {
        statements.push(db.insert(t.notifications).values(chunk));
      }
      try {
        const result = await runBatch(db, statements);
        return batchSucceeded(result);
      } catch (error) {
        if (error instanceof Error && /FOREIGN KEY constraint failed|SQLITE_CONSTRAINT_FOREIGNKEY/i.test(error.message)) {
          return false;
        }
        throw error;
      }
    },

    async findByIdInScope(scope: ProjectScope, id: string): Promise<Card | null> {
      const [row] = await db
        .select({
          id: t.cards.id,
          boardId: t.cards.boardId,
          columnId: t.cards.columnId,
          notepadId: t.cards.notepadId,
          position: t.cards.position,
          priority: t.cards.priority,
          dueDate: t.cards.dueDate,
          createdAt: t.cards.createdAt,
          title: t.notepads.title,
          content: t.notepads.content,
          version: t.notepads.version,
          projectId: t.notepads.projectId,
          workspaceId: t.notepads.workspaceId,
          deletedAt: t.notepads.deletedAt,
        })
        .from(t.cards)
        .innerJoin(t.notepads, eq(t.notepads.id, t.cards.notepadId))
        .innerJoin(t.boards, eq(t.boards.id, t.cards.boardId))
        .innerJoin(t.projects, eq(t.projects.id, t.boards.projectId))
        .innerJoin(t.boardColumns, eq(t.boardColumns.id, t.cards.columnId))
        .where(and(eq(t.cards.id, id), cardInProjectScope(scope, id), cardSourceAgreement(t)));
      return row ? mapCard(row) : null;
    },

    async getCardWithDetails(scope: ProjectScope, id: string): Promise<CardWithDetails | null> {
      const [card] = await db
        .select({
          id: t.cards.id,
          boardId: t.cards.boardId,
          columnId: t.cards.columnId,
          notepadId: t.cards.notepadId,
          position: t.cards.position,
          priority: t.cards.priority,
          dueDate: t.cards.dueDate,
          createdAt: t.cards.createdAt,
          title: t.notepads.title,
          content: t.notepads.content,
          version: t.notepads.version,
          projectId: t.notepads.projectId,
          workspaceId: t.notepads.workspaceId,
        })
        .from(t.cards)
        .innerJoin(t.notepads, eq(t.notepads.id, t.cards.notepadId))
        .innerJoin(t.boards, eq(t.boards.id, t.cards.boardId))
        .innerJoin(t.projects, eq(t.projects.id, t.boards.projectId))
        .innerJoin(t.boardColumns, eq(t.boardColumns.id, t.cards.columnId))
        .where(and(
          eq(t.cards.id, id),
          eq(t.projects.id, scope.projectId),
          eq(t.projects.workspaceId, scope.workspaceId),
          cardInProjectScope(scope, id),
          liveCardSource(t),
        ));

      if (!card) return null;

      const [board] = await db
        .select({ name: t.boards.name })
        .from(t.boards)
        .where(and(
          eq(t.boards.id, card.boardId),
          eq(t.boards.projectId, scope.projectId),
          eq(t.boards.workspaceId, scope.workspaceId),
        ));

      const [column] = await db
        .select({ name: t.boardColumns.name })
        .from(t.boardColumns)
        .innerJoin(t.boards, eq(t.boards.id, t.boardColumns.boardId))
        .where(and(
          eq(t.boardColumns.id, card.columnId),
          eq(t.boardColumns.boardId, card.boardId),
          eq(t.boards.projectId, scope.projectId),
          eq(t.boards.workspaceId, scope.workspaceId),
        ));

      const assignees = await db
        .select({
          userId: t.cardAssignees.userId,
          name: t.user.name,
          image: t.user.image,
        })
        .from(t.cardAssignees)
        .innerJoin(t.user, eq(t.user.id, t.cardAssignees.userId))
        .innerJoin(
          t.members,
                and(eq(t.members.userId, t.cardAssignees.userId), eq(t.members.workspaceId, scope.workspaceId)),
        )
        .where(eq(t.cardAssignees.cardId, id));

      const tags = await db
        .select({
          id: t.tags.id,
          name: t.tags.name,
          color: t.tags.color,
        })
        .from(t.notepadTags)
        .innerJoin(t.notepads, eq(t.notepads.id, t.notepadTags.notepadId))
        .innerJoin(t.tags, eq(t.tags.id, t.notepadTags.tagId))
        .where(
          and(
            eq(t.notepadTags.notepadId, card.notepadId),
            eq(t.tags.projectId, scope.projectId),
            eq(t.notepads.projectId, scope.projectId),
            eq(t.notepads.workspaceId, scope.workspaceId),
          ),
        );

      const subtasks = await db
        .select()
        .from(t.cardSubtasks)
        .where(eq(t.cardSubtasks.cardId, id))
        .orderBy(asc(t.cardSubtasks.position));

      const now = Date.now();
      const [lockRow] = await db
        .select()
        .from(t.editLocks)
        .where(eq(t.editLocks.notepadId, card.notepadId));

      let lock: { userId?: string; clientId?: string; name: string; expiresAt: number } | null =
        null;
      if (lockRow && lockRow.expiresAt > now) {
        const [holder] = await db
          .select({ name: t.user.name })
          .from(t.user)
          .innerJoin(t.members, eq(t.members.userId, t.user.id))
          .where(and(eq(t.user.id, lockRow.userId), eq(t.members.workspaceId, scope.workspaceId)));
        lock = {
          userId: holder ? lockRow.userId : undefined,
          clientId: holder ? lockRow.clientId : undefined,
          name: holder?.name || 'Someone',
          expiresAt: lockRow.expiresAt,
        };
      }

      return {
        ...card,
        dueDate: card.dueDate ?? null,
        boardName: board?.name ?? 'Board',
        columnName: column?.name ?? 'Column',
        assignees,
        tags,
        subtasks: subtasks.map(mapSubtask),
        lock,
      };
    },

    async updateGuarded(args: UpdateCardMutation): Promise<boolean> {
      const { cardId, scope, data, assigneeIds, tagIds, title, now } = args;
      const guard = db.run(sql`UPDATE cards SET id = id WHERE id = ${cardId}
        AND ${cardInScope(scope, cardId)} RETURNING id`);
      const statements: BatchItem<'sqlite'>[] = [guard];
      for (const candidate of args.assignmentNotifications ?? []) {
        statements.push(db.run(sql`INSERT INTO notifications
          (id, workspace_id, user_id, type, actor_id, notepad_id, card_id, read_at, created_at)
          SELECT ${candidate.id}, ${scope.workspaceId}, ${candidate.userId}, 'assigned',
            ${scope.actorUserId}, c.notepad_id, c.id, NULL, ${now}
          FROM cards c WHERE c.id = ${cardId} AND ${cardInScope(scope, cardId)}
            AND EXISTS (SELECT 1 FROM members target WHERE target.workspace_id = ${scope.workspaceId} AND target.user_id = ${candidate.userId})
            AND NOT EXISTS (SELECT 1 FROM card_assignees old WHERE old.card_id = c.id AND old.user_id = ${candidate.userId})`));
      }
      if (assigneeIds !== undefined) {
        statements.push(db.run(sql`DELETE FROM card_assignees WHERE card_id = ${cardId} AND ${cardInScope(scope, cardId)}`));
        for (const chunk of chunkByParamBudget([...new Set(assigneeIds)], 2, 0)) {
          for (const userId of chunk) {
            statements.push(db.run(sql`INSERT INTO card_assignees (card_id, user_id)
              SELECT ${cardId}, ${userId} WHERE ${cardInScope(scope, cardId)}
                AND EXISTS (SELECT 1 FROM members m WHERE m.workspace_id = ${scope.workspaceId} AND m.user_id = ${userId})`));
          }
        }
      }
      if (tagIds !== undefined) {
        statements.push(db.run(sql`DELETE FROM notepad_tags WHERE notepad_id = (SELECT notepad_id FROM cards WHERE id = ${cardId})
          AND ${cardInScope(scope, cardId)}`));
        for (const chunk of chunkByParamBudget([...new Set(tagIds)], 2, 0)) {
          for (const tagId of chunk) {
            statements.push(db.run(sql`INSERT INTO notepad_tags (notepad_id, tag_id)
              SELECT c.notepad_id, ${tagId} FROM cards c WHERE c.id = ${cardId} AND ${cardInScope(scope, cardId)}
                AND EXISTS (SELECT 1 FROM tags t JOIN notepads n ON n.id = c.notepad_id
                  WHERE t.id = ${tagId} AND t.project_id = n.project_id)`));
          }
        }
      }
      if (Object.keys(data).length > 0) {
        statements.push(db.update(t.cards).set(data).where(and(eq(t.cards.id, cardId), sql`${cardInScope(scope, cardId)}`)));
      }
      if (title) {
        statements.push(db.run(sql`UPDATE notepads SET title = ${title.value}, updated_at = ${now}
          WHERE id = (SELECT notepad_id FROM cards WHERE id = ${cardId}) AND ${cardInScope(scope, cardId)}`));
        statements.push(db.run(sql`DELETE FROM notepads_fts WHERE notepad_id = (SELECT notepad_id FROM cards WHERE id = ${cardId})
          AND ${cardInScope(scope, cardId)}`));
        statements.push(db.run(sql`INSERT INTO notepads_fts (notepad_id, project_id, title, body)
          SELECT n.id, n.project_id, ${title.value}, ${title.plainText} FROM notepads n
          JOIN cards c ON c.notepad_id = n.id WHERE c.id = ${cardId} AND ${cardInScope(scope, cardId)}`));
      }
      return batchSucceeded(await runBatch(db, statements));
    },

    async moveGuarded(id: string, columnId: string, position: string, scope: CardMutationScope): Promise<boolean> {
      const rows = await db.all<{ id: string }>(sql`UPDATE cards SET column_id = ${columnId}, position = ${position}
        WHERE id = ${id} AND ${cardInScope(scope, id)} AND EXISTS (
          SELECT 1 FROM boards b JOIN board_columns col ON col.board_id = b.id
          WHERE b.id = cards.board_id AND col.id = ${columnId} AND b.workspace_id = ${scope.workspaceId}
            AND b.deleted_at IS NULL
        ) RETURNING id`);
      return rows.length === 1;
    },

    // Subtasks
    async listSubtasks(scope: ProjectScope, cardId: string): Promise<CardSubtask[]> {
      const rows = await db
        .select()
        .from(t.cardSubtasks)
        .where(and(eq(t.cardSubtasks.cardId, cardId), cardInProjectScope(scope, cardId)))
        .orderBy(asc(t.cardSubtasks.position));
      return rows.map(mapSubtask);
    },

    async createSubtaskGuarded(data: CreateSubtaskData, scope: CardMutationScope): Promise<CardSubtask | null> {
      const rows = await db.all<CardSubtask>(sql`INSERT INTO card_subtasks (id, card_id, title, completed, position, created_at)
        SELECT ${data.id}, ${data.cardId}, ${data.title}, ${data.completed ? 1 : 0}, ${data.position}, ${data.createdAt}
        WHERE ${cardInScope(scope, data.cardId)} RETURNING id, card_id AS "cardId", title, completed, position, created_at AS "createdAt"`);
      return rows[0] ? mapSubtask(rows[0]) : null;
    },

    async updateSubtaskGuarded(id: string, cardId: string, data: UpdateSubtaskData, scope: CardMutationScope): Promise<boolean> {
      const rows = await db.all<{ id: string }>(sql`UPDATE card_subtasks SET
        title = CASE WHEN ${data.title !== undefined ? 1 : 0} THEN ${data.title ?? null} ELSE title END,
        completed = CASE WHEN ${data.completed !== undefined ? 1 : 0} THEN ${data.completed ? 1 : 0} ELSE completed END,
        position = CASE WHEN ${data.position !== undefined ? 1 : 0} THEN ${data.position ?? null} ELSE position END
        WHERE id = ${id} AND card_id = ${cardId} AND ${cardInScope(scope, cardId)} RETURNING id`);
      return rows.length === 1;
    },

    async deleteSubtaskGuarded(id: string, cardId: string, scope: CardMutationScope): Promise<boolean> {
      const rows = await db.all<{ id: string }>(sql`DELETE FROM card_subtasks WHERE id = ${id} AND card_id = ${cardId}
        AND ${cardInScope(scope, cardId)} RETURNING id`);
      return rows.length === 1;
    },

    // Assignees
    async listAssignees(scope: ProjectScope, cardId: string): Promise<CardAssignee[]> {
      const rows = await db
        .select({
          cardId: t.cardAssignees.cardId,
          userId: t.cardAssignees.userId,
          name: t.user.name,
          image: t.user.image,
        })
        .from(t.cardAssignees)
        .innerJoin(t.user, eq(t.user.id, t.cardAssignees.userId))
        .where(and(eq(t.cardAssignees.cardId, cardId), cardInProjectScope(scope, cardId)));
      return rows.map((r) => ({
        cardId: r.cardId,
        userId: r.userId,
        name: r.name,
        image: r.image,
      }));
    },

    async validateAssignees(workspaceId: string, userIds: string[]): Promise<{ userId: string }[]> {
      if (userIds.length === 0) return [];
      const results: { userId: string }[] = [];
      for (const chunk of chunkInList(userIds, 1)) {
        const rows = await db
          .select({ userId: t.members.userId })
          .from(t.members)
          .where(and(eq(t.members.workspaceId, workspaceId), inArray(t.members.userId, chunk)));
        results.push(...rows);
      }
      return results;
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

    // Comments
    async listComments(scope: ProjectScope, cardId: string): Promise<Comment[]> {
      const rows = await db
        .select({
          id: t.cardComments.id,
          cardId: t.cardComments.cardId,
          userId: t.cardComments.userId,
          content: t.cardComments.content,
          createdAt: t.cardComments.createdAt,
          updatedAt: t.cardComments.updatedAt,
          name: t.user.name,
          image: t.user.image,
        })
        .from(t.cardComments)
        .innerJoin(t.user, eq(t.user.id, t.cardComments.userId))
        .where(and(eq(t.cardComments.cardId, cardId), cardInProjectScope(scope, cardId)))
        .orderBy(asc(t.cardComments.createdAt));
      return rows.map(mapComment);
    },

    async createCommentGuarded(args: CreateCommentMutation): Promise<Comment | null> {
      const { data, scope, now } = args;
      const statements: BatchItem<'sqlite'>[] = [db.run(sql`INSERT INTO card_comments
        (id, card_id, user_id, content, created_at, updated_at)
        SELECT ${data.id}, ${data.cardId}, ${data.userId}, ${data.content}, ${data.createdAt}, ${data.updatedAt}
        WHERE ${cardInScope(scope, data.cardId)} AND ${data.userId} = ${scope.actorUserId}
        RETURNING id`)];
      for (const target of args.mentionNotifications) {
        statements.push(db.run(sql`INSERT INTO notifications
          (id, workspace_id, user_id, type, actor_id, notepad_id, card_id, read_at, created_at)
          SELECT ${target.id}, ${scope.workspaceId}, ${target.userId}, 'mention', ${scope.actorUserId},
            c.notepad_id, c.id, NULL, ${now} FROM cards c
          WHERE c.id = ${data.cardId} AND ${cardInScope(scope, data.cardId)}
            AND EXISTS (SELECT 1 FROM card_comments cc WHERE cc.id = ${data.id} AND cc.card_id = c.id)
            AND EXISTS (SELECT 1 FROM members m WHERE m.workspace_id = ${scope.workspaceId} AND m.user_id = ${target.userId})`));
      }
      const succeeded = batchSucceeded(await runBatch(db, statements));
      if (!succeeded) return null;
      const [source] = await db.select({ projectId: t.projects.id }).from(t.cards)
        .innerJoin(t.boards, eq(t.boards.id, t.cards.boardId))
        .innerJoin(t.projects, eq(t.projects.id, t.boards.projectId))
        .innerJoin(t.boardColumns, eq(t.boardColumns.id, t.cards.columnId))
        .innerJoin(t.notepads, eq(t.notepads.id, t.cards.notepadId))
        .where(and(
          eq(t.cards.id, data.cardId),
          eq(t.projects.workspaceId, scope.workspaceId),
          cardSourceAgreement(t),
        ));
      return source
        ? this.getComment({ workspaceId: scope.workspaceId, projectId: source.projectId }, data.id, data.cardId)
        : null;
    },

    async getComment(scope: ProjectScope, id: string, cardId: string): Promise<Comment | null> {
      const [row] = await db
        .select({
          id: t.cardComments.id,
          cardId: t.cardComments.cardId,
          userId: t.cardComments.userId,
          content: t.cardComments.content,
          createdAt: t.cardComments.createdAt,
          updatedAt: t.cardComments.updatedAt,
          name: t.user.name,
          image: t.user.image,
        })
        .from(t.cardComments)
        .innerJoin(t.user, eq(t.user.id, t.cardComments.userId))
        .where(and(
          eq(t.cardComments.id, id),
          eq(t.cardComments.cardId, cardId),
          cardInProjectScope(scope, cardId),
        ));
      return row ? mapComment(row) : null;
    },

    async deleteCommentGuarded(id: string, cardId: string, scope: CardMutationScope): Promise<CommentDeleteResult> {
      const deleted = await db.all<{ id: string }>(sql`DELETE FROM card_comments WHERE id = ${id} AND card_id = ${cardId}
        AND ${cardInScope(scope, cardId)} AND EXISTS (
          SELECT 1 FROM members m WHERE m.workspace_id = ${scope.workspaceId} AND m.user_id = ${scope.actorUserId}
            AND (card_comments.user_id = ${scope.actorUserId} OR m.role = 'owner')
        ) RETURNING id`);
      if (deleted.length === 1) return 'deleted';
      const [comment] = await db.select({ id: t.cardComments.id }).from(t.cardComments)
        .where(and(eq(t.cardComments.id, id), eq(t.cardComments.cardId, cardId)));
      return comment ? 'forbidden' : 'not_found';
    },

    // Queries
    async listByColumn(scope: ProjectScope, columnId: string): Promise<Card[]> {
      const rows = await db
        .select({
          id: t.cards.id,
          boardId: t.cards.boardId,
          columnId: t.cards.columnId,
          notepadId: t.cards.notepadId,
          position: t.cards.position,
          priority: t.cards.priority,
          dueDate: t.cards.dueDate,
          createdAt: t.cards.createdAt,
          title: t.notepads.title,
          content: t.notepads.content,
          version: t.notepads.version,
          projectId: t.notepads.projectId,
          workspaceId: t.notepads.workspaceId,
        })
        .from(t.cards)
        .innerJoin(t.notepads, eq(t.notepads.id, t.cards.notepadId))
        .innerJoin(t.boards, eq(t.boards.id, t.cards.boardId))
        .innerJoin(t.projects, eq(t.projects.id, t.boards.projectId))
        .innerJoin(t.boardColumns, eq(t.boardColumns.id, t.cards.columnId))
        .where(and(
          eq(t.cards.columnId, columnId),
          eq(t.projects.workspaceId, scope.workspaceId),
          eq(t.projects.id, scope.projectId),
          liveCardSource(t),
        ))
        .orderBy(asc(t.cards.position));
      return rows.map(mapCard);
    },

    async getMyTasks(
      workspaceId: string,
      userId: string,
      filters: MyTasksFilters,
    ): Promise<MyTaskItem[]> {
      const rows = await db
        .select({
          id: t.cards.id,
          notepadId: t.cards.notepadId,
          boardId: t.cards.boardId,
          columnId: t.cards.columnId,
          projectId: t.projects.id,
          title: t.notepads.title,
          dueDate: t.cards.dueDate,
          priority: t.cards.priority,
          createdAt: t.cards.createdAt,
          boardName: t.boards.name,
          columnName: t.boardColumns.name,
          projectName: t.projects.name,
          projectIcon: t.projects.icon,
          projectColor: t.projects.color,
        })
        .from(t.cards)
        .innerJoin(t.cardAssignees, eq(t.cardAssignees.cardId, t.cards.id))
        .innerJoin(t.notepads, eq(t.notepads.id, t.cards.notepadId))
        .innerJoin(t.boards, eq(t.boards.id, t.cards.boardId))
        .innerJoin(t.boardColumns, eq(t.boardColumns.id, t.cards.columnId))
        .innerJoin(t.projects, eq(t.projects.id, t.boards.projectId))
        .where(
          and(
            eq(t.cardAssignees.userId, userId),
            eq(t.projects.workspaceId, workspaceId),
            liveCardSource(t),
            isNull(t.projects.archivedAt),
            filters.projectId ? eq(t.boards.projectId, filters.projectId) : undefined,
          ),
        )
        .orderBy(desc(t.cards.dueDate), asc(t.cards.position));

      const status = filters.status ?? 'all';
      const isCompletedColumn = (columnName: string) =>
        /done|completed|closed|shipped/i.test(columnName);

      const filtered =
        status === 'all'
          ? rows
          : rows.filter((r) => {
              const completed = isCompletedColumn(r.columnName);
              return status === 'completed' ? completed : !completed;
            });

      if (filtered.length === 0) return [];

      // Tags for the matched card notepads
      const notepadIds = filtered.map((r) => r.notepadId);
      const tagRows: Array<{
        notepadId: string;
        tagId: string;
        name: string;
        color: string | null;
      }> = [];
      for (const chunk of chunkInList(notepadIds, 0)) {
        const more = await db
          .select({
            notepadId: t.notepadTags.notepadId,
            tagId: t.tags.id,
            name: t.tags.name,
            color: t.tags.color,
          })
          .from(t.notepadTags)
          .innerJoin(t.tags, eq(t.tags.id, t.notepadTags.tagId))
          .innerJoin(
            t.notepads,
            and(
              eq(t.notepads.id, t.notepadTags.notepadId),
              eq(t.notepads.projectId, t.tags.projectId),
            ),
          )
          .where(inArray(t.notepadTags.notepadId, chunk));
        tagRows.push(...more);
      }

      const tagsByNotepad = new Map<string, MyTaskItem['tags']>();
      for (const tag of tagRows) {
        const list = tagsByNotepad.get(tag.notepadId) || [];
        list.push({ id: tag.tagId, name: tag.name, color: tag.color });
        tagsByNotepad.set(tag.notepadId, list);
      }

      return filtered.map((r) => ({
        id: r.id,
        notepadId: r.notepadId,
        boardId: r.boardId,
        columnId: r.columnId,
        projectId: r.projectId,
        title: r.title,
        dueDate: r.dueDate,
        priority: r.priority as CardPriority | null,
        isCompleted: isCompletedColumn(r.columnName),
        createdAt: r.createdAt,
        boardName: r.boardName,
        columnName: r.columnName,
        projectName: r.projectName,
        projectIcon: r.projectIcon,
        projectColor: r.projectColor,
        tags: tagsByNotepad.get(r.notepadId) || [],
      }));
    },

    async getCardsSummary(scope: ProjectScope, cardIds: string[]): Promise<CardSummary[]> {
      if (cardIds.length === 0) return [];

      const rows: Array<Omit<CardSummary, 'assignees'>> = [];

      for (const chunk of chunkInList([...new Set(cardIds)], 3)) {
        const chunkRows = await db
          .select({
            id: t.cards.id,
            notepadId: t.cards.notepadId,
            boardId: t.cards.boardId,
            columnId: t.cards.columnId,
            priority: t.cards.priority,
            dueDate: t.cards.dueDate,
            title: t.notepads.title,
            boardName: t.boards.name,
            columnName: t.boardColumns.name,
          })
          .from(t.cards)
          .innerJoin(t.notepads, eq(t.notepads.id, t.cards.notepadId))
          .innerJoin(t.boards, eq(t.boards.id, t.cards.boardId))
          .innerJoin(
            t.boardColumns,
            and(
              eq(t.boardColumns.id, t.cards.columnId),
              eq(t.boardColumns.boardId, t.cards.boardId),
            ),
          )
          .innerJoin(t.projects, eq(t.projects.id, t.boards.projectId))
          .where(
            and(
              inArray(t.cards.id, chunk),
              eq(t.projects.workspaceId, scope.workspaceId),
              eq(t.projects.id, scope.projectId),
              liveCardSource(t),
            ),
          );
        rows.push(...chunkRows);
      }

      if (rows.length === 0) return [];

      const fetchedCardIds = rows.map((r) => r.id);
      const assignees: Array<{ cardId: string } & CardSummary['assignees'][number]> = [];

      for (const chunk of chunkInList(fetchedCardIds, 1)) {
        const chunkAssignees = await db
          .select({
            cardId: t.cardAssignees.cardId,
            userId: t.cardAssignees.userId,
            name: t.user.name,
            image: t.user.image,
          })
          .from(t.cardAssignees)
          .innerJoin(
            t.members,
            and(
              eq(t.members.userId, t.cardAssignees.userId),
              eq(t.members.workspaceId, scope.workspaceId),
            ),
          )
          .innerJoin(t.user, eq(t.user.id, t.members.userId))
          .where(inArray(t.cardAssignees.cardId, chunk));
        assignees.push(...chunkAssignees);
      }

      const assigneesByCard = new Map<string, CardSummary['assignees']>();
      for (const { cardId, ...assignee } of assignees) {
        const list = assigneesByCard.get(cardId) || [];
        list.push(assignee);
        assigneesByCard.set(cardId, list);
      }
      return rows.map((row) => ({ ...row, assignees: assigneesByCard.get(row.id) || [] }));
    },

    // Search/suggest
    async findByPattern(
      scope: ProjectScope,
      pattern: string,
      limit: number,
    ): Promise<{ id: string; title: string; boardName: string; priority: CardPriority | null }[]> {
      const searchPattern = `%${pattern}%`;
      const rows = await db
        .select({
          id: t.cards.id,
          title: t.notepads.title,
          boardName: t.boards.name,
          priority: t.cards.priority,
        })
        .from(t.cards)
        .innerJoin(t.notepads, eq(t.notepads.id, t.cards.notepadId))
        .innerJoin(t.boards, eq(t.boards.id, t.cards.boardId))
        .innerJoin(t.projects, eq(t.projects.id, t.boards.projectId))
        .innerJoin(t.boardColumns, eq(t.boardColumns.id, t.cards.columnId))
        .where(
          and(
            eq(t.projects.id, scope.projectId),
            eq(t.projects.workspaceId, scope.workspaceId),
            liveCardSource(t),
            sql`${t.notepads.title} LIKE ${searchPattern}`,
          ),
        )
        .orderBy(asc(t.notepads.title))
        .limit(limit);
      return rows.map((r) => ({
        id: r.id,
        title: r.title,
        boardName: r.boardName,
        priority: r.priority as CardPriority | null,
      }));
    },
  };
}

interface CardRow {
  id: string;
  boardId: string;
  columnId: string;
  notepadId: string;
  position: string;
  priority: CardPriority | null;
  dueDate: number | null;
  createdAt: number;
  title: string;
  content: string;
  version: number;
  projectId: string;
  workspaceId: string;
  deletedAt?: number | null;
}

function mapCard(row: CardRow): Card {
  return {
    id: row.id,
    boardId: row.boardId,
    columnId: row.columnId,
    notepadId: row.notepadId,
    position: row.position,
    priority: row.priority,
    dueDate: row.dueDate ?? null,
    createdAt: row.createdAt,
    title: row.title,
    content: row.content,
    version: row.version,
    projectId: row.projectId,
    workspaceId: row.workspaceId,
    deletedAt: row.deletedAt ?? null,
  } as Card;
}

function mapSubtask(row: typeof t.cardSubtasks.$inferSelect): CardSubtask {
  return {
    id: row.id,
    cardId: row.cardId,
    title: row.title,
    completed: row.completed,
    position: row.position,
    createdAt: row.createdAt,
  };
}

function mapComment(row: {
  id: string;
  cardId: string;
  userId: string;
  content: string;
  createdAt: number;
  updatedAt: number;
  name: string;
  image: string | null;
}): Comment {
  return {
    id: row.id,
    cardId: row.cardId,
    userId: row.userId,
    content: row.content,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    name: row.name,
    image: row.image,
  };
}

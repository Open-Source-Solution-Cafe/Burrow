import type {
  IBoardRepository,
  Board,
  CreateBoardData,
  UpdateBoardData,
  BoardColumn,
  BoardWithDetails,
  CreateColumnData,
  UpdateColumnData,
  BoardMutationScope,
  ProjectScope,
} from '../../../../infrastructure/types';
import { eq, and, isNotNull, isNull, desc, inArray, sql } from 'drizzle-orm';
import { boardInProjectScope } from '../../board-source';
import type { PostgresDb } from '../index';
import {
  boards,
  boardColumns,
  cards,
  notepads,
  cardAssignees,
  members,
  user,
  notepadTags,
  notepadLinks,
  tags,
  cardSubtasks,
  projects,
  workspaces,
} from '../schema';

const validCardBodyForBoard = (boardId: string) => sql`exists (
  select 1
  from cards c
  join boards b on b.id = c.board_id
  join projects p on p.id = b.project_id
  join board_columns bc on bc.id = c.column_id and bc.board_id = c.board_id
  where c.notepad_id = ${notepads.id}
    and c.board_id = ${boardId}
    and notepads.project_id = p.id
    and notepads.workspace_id = p.workspace_id
    and b.workspace_id = p.workspace_id
    and notepads.kind = 'card'
)`;

export class PostgresBoardRepository implements IBoardRepository {
  constructor(private db: PostgresDb) {}
  private readonly sourceProjectMatches = sql`exists (select 1 from projects where projects.id = ${boards.projectId} and projects.workspace_id = ${boards.workspaceId})`;

  private async withWorkspaceWrite<T>(scope: BoardMutationScope, mutate: (tx: any) => Promise<T>): Promise<T | null> {
    return this.db.transaction(async (tx) => {
      await tx.select({ id: workspaces.id }).from(workspaces)
        .where(eq(workspaces.id, scope.workspaceId)).for('update');
      const [member] = await tx.select({ role: members.role }).from(members)
        .where(and(eq(members.workspaceId, scope.workspaceId), eq(members.userId, scope.actorUserId)));
      if (!member || (scope.minimumRole === 'owner' ? member.role !== 'owner' : member.role === 'viewer')) {
        return null;
      }
      return mutate(tx);
    });
  }

  async listByProject(scope: ProjectScope): Promise<Board[]> {
    return this.db
      .select()
      .from(boards)
      .where(
        and(
          eq(boards.projectId, scope.projectId),
          eq(boards.workspaceId, scope.workspaceId),
          isNull(boards.deletedAt),
          this.sourceProjectMatches,
        ),
      )
      .orderBy(boards.position);
  }

  async findByIdInScope(scope: ProjectScope, id: string): Promise<Board | null> {
    const result = await this.db.select().from(boards)
      .where(and(eq(boards.id, id), boardInProjectScope(scope, id))).limit(1);
    return result[0] ?? null;
  }

  async listDeletedByProject(scope: ProjectScope): Promise<Board[]> {
    return this.db
      .select()
      .from(boards)
      .where(
        and(
          eq(boards.projectId, scope.projectId),
          eq(boards.workspaceId, scope.workspaceId),
          isNotNull(boards.deletedAt),
          this.sourceProjectMatches,
        ),
      )
      .orderBy(desc(boards.deletedAt));
  }

  async createWithColumns(data: CreateBoardData, columns: CreateColumnData[], scope: BoardMutationScope): Promise<boolean> {
    const result = await this.withWorkspaceWrite(scope, async (tx) => {
      if (data.workspaceId !== scope.workspaceId) return false;
      const [project] = await tx.select({ id: projects.id }).from(projects)
        .where(and(eq(projects.id, data.projectId), eq(projects.workspaceId, scope.workspaceId)));
      if (!project) return false;
      await tx.insert(boards).values(data);
      if (columns.length > 0) await tx.insert(boardColumns).values(columns);
      return true;
    });
    return result === true;
  }

  async updateGuarded(id: string, data: UpdateBoardData, scope: BoardMutationScope): Promise<boolean> {
    const result = await this.withWorkspaceWrite(scope, async (tx) => {
      const rows = await tx.update(boards).set(data).where(and(
        eq(boards.id, id), eq(boards.workspaceId, scope.workspaceId), isNull(boards.deletedAt),
        this.sourceProjectMatches,
      )).returning({ id: boards.id });
      return rows.length === 1;
    });
    return result === true;
  }

  async softDeleteGuarded(id: string, deletedAt: number, scope: BoardMutationScope): Promise<boolean> {
    const deletionOperationId = crypto.randomUUID();
    const result = await this.withWorkspaceWrite(scope, async (tx) => {
      const [board] = await tx
        .select({ deletedAt: boards.deletedAt })
        .from(boards)
        .where(and(eq(boards.id, id), eq(boards.workspaceId, scope.workspaceId), this.sourceProjectMatches))
        .for('update');
      if (!board || board.deletedAt !== null) return false;

      await tx
        .update(notepads)
        .set({ deletedAt, deletionOperationId, updatedAt: deletedAt })
        .where(and(validCardBodyForBoard(id), isNull(notepads.deletedAt)));

      await tx
        .update(boards)
        .set({ deletedAt, deletionOperationId, updatedAt: deletedAt })
        .where(and(eq(boards.id, id), isNull(boards.deletedAt), this.sourceProjectMatches));
      return true;
    });
    return result === true;
  }

  async restoreGuarded(id: string, scope: BoardMutationScope): Promise<boolean> {
    const result = await this.withWorkspaceWrite(scope, async (tx) => {
      const [board] = await tx
        .select({ deletedAt: boards.deletedAt, deletionOperationId: boards.deletionOperationId })
        .from(boards)
      .where(and(eq(boards.id, id), eq(boards.workspaceId, scope.workspaceId), this.sourceProjectMatches))
      .for('update');
      const deleteTimestamp = board?.deletedAt;
      const deletionOperationId = board?.deletionOperationId;
      if (deleteTimestamp === null || deleteTimestamp === undefined) return false;
      const now = Date.now();

      if (!deletionOperationId) {
        const legacyBodies = await tx
          .select({ id: notepads.id })
          .from(notepads)
          .where(and(validCardBodyForBoard(id), eq(notepads.deletedAt, deleteTimestamp)));
        if (legacyBodies.length > 0) throw new Error('ambiguous_delete_group');
      } else {
        await tx
          .update(notepads)
          .set({ deletedAt: null, deletionOperationId: null, updatedAt: now })
          .where(and(validCardBodyForBoard(id), eq(notepads.deletionOperationId, deletionOperationId)));
      }

      await tx
        .update(boards)
        .set({ deletedAt: null, deletionOperationId: null, updatedAt: now })
        .where(and(eq(boards.id, id), eq(boards.workspaceId, scope.workspaceId), eq(boards.deletedAt, deleteTimestamp)))
        .returning({ id: boards.id });
      return true;
    });
    return result === true;
  }

  async hardDeleteGuarded(id: string, scope: BoardMutationScope): Promise<boolean> {
    const result = await this.withWorkspaceWrite(scope, async (tx) => {
      const [board] = await tx.select({ id: boards.id }).from(boards).where(and(
        eq(boards.id, id), eq(boards.workspaceId, scope.workspaceId), isNotNull(boards.deletedAt), this.sourceProjectMatches,
      )).for('update');
      if (!board) return false;
      const cardRows = await tx
        .select({ notepadId: notepads.id, projectId: notepads.projectId })
        .from(notepads)
        .where(validCardBodyForBoard(id));

      for (const { notepadId, projectId } of cardRows) {
        await tx
          .delete(notepadLinks)
          .where(
            and(
              eq(notepadLinks.targetId, notepadId),
              sql`${notepadLinks.sourceId} in (select id from notepads where project_id = ${projectId})`,
            ),
          );
        await tx.delete(notepads).where(and(eq(notepads.id, notepadId), validCardBodyForBoard(id)));
      }
      const deleted = await tx.delete(boards).where(and(
        eq(boards.id, id), eq(boards.workspaceId, scope.workspaceId), isNotNull(boards.deletedAt),
      )).returning({ id: boards.id });
      return deleted.length === 1;
    });
    return result === true;
  }

  // Columns
  async listColumns(scope: ProjectScope, boardId: string): Promise<BoardColumn[]> {
    return this.db
      .select()
      .from(boardColumns)
      .where(and(eq(boardColumns.boardId, boardId), boardInProjectScope(scope, boardId)))
      .orderBy(boardColumns.position);
  }

  async findColumnByIdInScope(scope: ProjectScope, columnId: string): Promise<BoardColumn | null> {
    const result = await this.db
      .select({ column: boardColumns })
      .from(boardColumns)
      .innerJoin(boards, eq(boardColumns.boardId, boards.id))
      .where(and(
        eq(boardColumns.id, columnId),
        isNull(boards.deletedAt),
        this.sourceProjectMatches,
        eq(boards.workspaceId, scope.workspaceId),
        eq(boards.projectId, scope.projectId),
      ))
      .limit(1);
    return result[0]?.column ?? null;
  }

  async createColumnGuarded(data: CreateColumnData, scope: BoardMutationScope): Promise<boolean> {
    const result = await this.withWorkspaceWrite(scope, async (tx) => {
      const [board] = await tx.select({ id: boards.id }).from(boards).where(and(
        eq(boards.id, data.boardId), eq(boards.workspaceId, scope.workspaceId),
        isNull(boards.deletedAt), this.sourceProjectMatches,
      ));
      if (!board) return false;
      const rows = await tx.insert(boardColumns).values(data).returning({ id: boardColumns.id });
      return rows.length === 1;
    });
    return result === true;
  }

  async updateColumnGuarded(id: string, data: UpdateColumnData, scope: BoardMutationScope): Promise<boolean> {
    const result = await this.withWorkspaceWrite(scope, async (tx) => {
      const rows = await tx.update(boardColumns).set(data).where(and(
        eq(boardColumns.id, id), sql`exists (select 1 from boards b where b.id = ${boardColumns.boardId}
          and b.workspace_id = ${scope.workspaceId} and b.deleted_at is null
          and exists (select 1 from projects p where p.id = b.project_id and p.workspace_id = b.workspace_id))`,
      )).returning({ id: boardColumns.id });
      return rows.length === 1;
    });
    return result === true;
  }

  async moveColumnGuarded(id: string, position: string, scope: BoardMutationScope): Promise<boolean> {
    const result = await this.withWorkspaceWrite(scope, async (tx) => {
      const rows = await tx.update(boardColumns).set({ position }).where(and(
        eq(boardColumns.id, id), sql`exists (select 1 from boards b where b.id = ${boardColumns.boardId}
          and b.workspace_id = ${scope.workspaceId} and b.deleted_at is null
          and exists (select 1 from projects p where p.id = b.project_id and p.workspace_id = b.workspace_id))`,
      )).returning({ id: boardColumns.id });
      return rows.length === 1;
    });
    return result === true;
  }

  async deleteColumnGuarded(id: string, moveToColumnId: string | null, scope: BoardMutationScope): Promise<boolean> {
    const result = await this.withWorkspaceWrite(scope, async (tx) => {
      const [source] = await tx.select({ boardId: boardColumns.boardId }).from(boardColumns).innerJoin(
        boards, eq(boards.id, boardColumns.boardId),
      ).where(and(
        eq(boardColumns.id, id), eq(boards.workspaceId, scope.workspaceId), isNull(boards.deletedAt), this.sourceProjectMatches,
      ));
      if (!source) return false;
      if (moveToColumnId) {
        const [destination] = await tx.select({ id: boardColumns.id }).from(boardColumns).where(and(
          eq(boardColumns.id, moveToColumnId), eq(boardColumns.boardId, source.boardId),
        ));
        if (!destination || destination.id === id) return false;
        await tx.update(cards).set({ columnId: moveToColumnId }).where(and(
          eq(cards.columnId, id), eq(cards.boardId, source.boardId),
        ));
      } else {
        const [card] = await tx.select({ id: cards.id }).from(cards).where(eq(cards.columnId, id)).limit(1);
        if (card) return false;
      }
      const deleted = await tx.delete(boardColumns).where(and(
        eq(boardColumns.id, id), eq(boardColumns.boardId, source.boardId),
        sql`not exists (select 1 from cards c where c.column_id = ${id})`,
      )).returning({ id: boardColumns.id });
      return deleted.length === 1;
    });
    return result === true;
  }

  async getBoardWithDetails(
    scope: ProjectScope,
    boardId: string,
  ): Promise<BoardWithDetails | null> {
    const boardResult = await this.db
      .select()
      .from(boards)
      .where(
        and(
          eq(boards.id, boardId),
          eq(boards.workspaceId, scope.workspaceId),
          eq(boards.projectId, scope.projectId),
          this.sourceProjectMatches,
          isNull(boards.deletedAt),
        ),
      )
      .limit(1);

    const board = boardResult[0];
    if (!board) return null;

    const cols = await this.db
      .select()
      .from(boardColumns)
      .where(eq(boardColumns.boardId, boardId))
      .orderBy(boardColumns.position);

    const cardsWithNotepads = await this.db
      .select({
        id: cards.id,
        boardId: cards.boardId,
        columnId: cards.columnId,
        notepadId: cards.notepadId,
        title: notepads.title,
        position: cards.position,
        priority: cards.priority,
        dueDate: cards.dueDate,
        createdAt: cards.createdAt,
      })
      .from(cards)
      .innerJoin(notepads, eq(notepads.id, cards.notepadId))
      .innerJoin(
        boardColumns,
        and(eq(boardColumns.id, cards.columnId), eq(boardColumns.boardId, cards.boardId)),
      )
      .where(
        and(
          eq(cards.boardId, boardId),
          eq(notepads.workspaceId, scope.workspaceId),
          eq(notepads.projectId, scope.projectId),
          eq(notepads.kind, 'card'),
          isNull(notepads.deletedAt),
        ),
      )
      .orderBy(cards.position);

    const cardIds = cardsWithNotepads.map((c) => c.id);
    const assignees =
      cardIds.length > 0
        ? await this.db
            .select({
              cardId: cardAssignees.cardId,
              userId: cardAssignees.userId,
              name: user.name,
              image: user.image,
            })
            .from(cardAssignees)
            .innerJoin(user, eq(user.id, cardAssignees.userId))
            .innerJoin(
              members,
              and(eq(members.userId, cardAssignees.userId), eq(members.workspaceId, scope.workspaceId)),
            )
            .where(inArray(cardAssignees.cardId, cardIds))
        : [];

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
    const cardTags =
      notepadIds.length > 0
        ? await this.db
            .select({
              notepadId: notepadTags.notepadId,
              tagId: tags.id,
              name: tags.name,
              color: tags.color,
            })
            .from(notepadTags)
            .innerJoin(tags, eq(tags.id, notepadTags.tagId))
            .where(
              and(inArray(notepadTags.notepadId, notepadIds), eq(tags.projectId, board.projectId)),
            )
        : [];

    const tagsByNotepad = new Map<
      string,
      Array<{ id: string; name: string; color: string | null }>
    >();
    for (const tag of cardTags) {
      const list = tagsByNotepad.get(tag.notepadId) || [];
      list.push({ id: tag.tagId, name: tag.name, color: tag.color });
      tagsByNotepad.set(tag.notepadId, list);
    }

    const subtaskCounts =
      cardIds.length > 0
        ? await this.db
            .select({
              cardId: cardSubtasks.cardId,
              total: sql<number>`count(*)`,
              completed: sql<number>`coalesce(sum(case when ${cardSubtasks.completed} then 1 else 0 end), 0)`,
            })
            .from(cardSubtasks)
            .where(inArray(cardSubtasks.cardId, cardIds))
            .groupBy(cardSubtasks.cardId)
        : [];

    const subtasksByCard = new Map<string, { total: number; completed: number }>();
    for (const row of subtaskCounts) {
      subtasksByCard.set(row.cardId, {
        total: Number(row.total),
        completed: Number(row.completed),
      });
    }

    const cardsByColumn = new Map<string, any[]>();
    for (const card of cardsWithNotepads) {
      const cardAssigneesList = assigneesByCard.get(card.id) || [];
      const cardTagsList = tagsByNotepad.get(card.notepadId) || [];
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
        assignees: cardAssigneesList,
        tags: cardTagsList,
        totalSubtasks: subtaskProgress.total,
        completedSubtasks: subtaskProgress.completed,
      });
      cardsByColumn.set(card.columnId, list);
    }

    return {
      ...board,
      columns: cols.map((col) => ({
        ...col,
        cards: cardsByColumn.get(col.id) || [],
      })),
    };
  }
}

import { cardInProjectScope, cardSourceAgreement, liveCardSource } from '../../card-source';
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
  Comment,
  MyTasksFilters,
  MyTaskItem,
  CardSummary,
  ProjectScope,
  CardPriority,
  CardWithDetails,
  CardPlan,
} from '../../../../infrastructure/types';
import { eq, and, inArray, asc, sql, isNull } from 'drizzle-orm';
import type { PostgresDb } from '../index';
import { cardCreationRows } from '../../../../entities/card';
import {
  cards,
  cardSubtasks,
  cardAssignees,
  cardComments,
  boardColumns,
  boards,
  notepads,
  projects,
  members,
  tags,
  notepadTags,
  user,
  editLocks,
  notepadLinks,
  notifications,
  workspaces,
} from '../schema';

const sourceTables = { cards, boards, boardColumns, projects, notepads };

export class PostgresCardRepository implements ICardRepository {
  constructor(private db: PostgresDb) {}

  private async withWorkspaceWrite<T>(scope: CardMutationScope, mutate: (tx: any) => Promise<T>): Promise<T | null> {
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

  async createFromPlan(plan: CardPlan): Promise<boolean> {
    const rows = cardCreationRows(plan);
    const result = await this.withWorkspaceWrite({
      workspaceId: plan.workspaceId,
      actorUserId: plan.actorId,
      minimumRole: 'editor',
    }, async (tx) => {
      const [source] = await tx.select({ projectId: boards.projectId }).from(boards)
        .innerJoin(boardColumns, eq(boardColumns.boardId, boards.id))
        .where(and(eq(boards.id, plan.boardId), eq(boards.workspaceId, plan.workspaceId),
          eq(boards.projectId, plan.projectId), eq(boardColumns.id, plan.columnId), isNull(boards.deletedAt)));
      if (!source) return false;
      await tx.insert(notepads).values(rows.notepads);
      await tx.insert(cards).values(rows.card);
      if (rows.links.length) await tx.insert(notepadLinks).values(rows.links);
      if (rows.assignees.length) await tx.insert(cardAssignees).values(rows.assignees);
      if (rows.tags.length) await tx.insert(notepadTags).values(rows.tags);
      if (rows.notifications.length) await tx.insert(notifications).values(rows.notifications);
      return true;
    });
    return result === true;
  }

  async findByIdInScope(scope: ProjectScope, id: string): Promise<Card | null> {
    const result = await this.db
      .select({
        id: cards.id,
        boardId: cards.boardId,
        columnId: cards.columnId,
        notepadId: cards.notepadId,
        position: cards.position,
        priority: cards.priority,
        dueDate: cards.dueDate,
        createdAt: cards.createdAt,
        projectId: projects.id,
        deletedAt: notepads.deletedAt,
      })
      .from(cards)
      .innerJoin(notepads, eq(cards.notepadId, notepads.id))
      .innerJoin(boards, eq(cards.boardId, boards.id))
      .innerJoin(projects, eq(boards.projectId, projects.id))
      .innerJoin(boardColumns, eq(cards.columnId, boardColumns.id))
      .where(and(eq(cards.id, id), cardInProjectScope(scope, id), cardSourceAgreement(sourceTables)))
      .limit(1);
    return result[0] ?? null;
  }

  async getCardWithDetails(scope: ProjectScope, id: string): Promise<CardWithDetails | null> {
    const [card] = await this.db
      .select({
        id: cards.id,
        boardId: cards.boardId,
        columnId: cards.columnId,
        notepadId: cards.notepadId,
        position: cards.position,
        priority: cards.priority,
        dueDate: cards.dueDate,
        createdAt: cards.createdAt,
        projectId: projects.id,
        workspaceId: projects.workspaceId,
        title: notepads.title,
        content: notepads.content,
        version: notepads.version,
      })
      .from(cards)
      .innerJoin(notepads, eq(cards.notepadId, notepads.id))
      .innerJoin(boards, eq(cards.boardId, boards.id))
      .innerJoin(projects, eq(boards.projectId, projects.id))
      .innerJoin(boardColumns, eq(cards.columnId, boardColumns.id))
      .where(
        and(
          eq(cards.id, id),
          eq(projects.id, scope.projectId),
          eq(projects.workspaceId, scope.workspaceId),
          cardInProjectScope(scope, id),
          liveCardSource(sourceTables),
        ),
      )
      .limit(1);

    if (!card) return null;

    const [board] = await this.db
      .select({ name: boards.name })
      .from(boards)
      .where(and(
        eq(boards.id, card.boardId),
        eq(boards.projectId, scope.projectId),
        eq(boards.workspaceId, scope.workspaceId),
      ))
      .limit(1);

    const [column] = await this.db
      .select({ name: boardColumns.name })
      .from(boardColumns)
      .innerJoin(boards, eq(boards.id, boardColumns.boardId))
      .where(and(
        eq(boardColumns.id, card.columnId),
        eq(boardColumns.boardId, card.boardId),
        eq(boards.projectId, scope.projectId),
        eq(boards.workspaceId, scope.workspaceId),
      ))
      .limit(1);

    const assignees = await this.db
      .select({
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
      .where(eq(cardAssignees.cardId, id));

    const cardTags = await this.db
      .select({
        id: tags.id,
        name: tags.name,
        color: tags.color,
      })
      .from(notepadTags)
      .innerJoin(notepads, eq(notepads.id, notepadTags.notepadId))
      .innerJoin(tags, eq(tags.id, notepadTags.tagId))
      .where(and(
        eq(notepadTags.notepadId, card.notepadId),
        eq(tags.projectId, scope.projectId),
        eq(notepads.projectId, scope.projectId),
        eq(notepads.workspaceId, scope.workspaceId),
      ));

    const subtasks = await this.db
      .select()
      .from(cardSubtasks)
      .where(eq(cardSubtasks.cardId, id))
      .orderBy(asc(cardSubtasks.position));

    const now = Date.now();
    const [lockRow] = await this.db
      .select()
      .from(editLocks)
      .where(eq(editLocks.notepadId, card.notepadId))
      .limit(1);

    let lock: { userId?: string; clientId?: string; name: string; expiresAt: number } | null = null;
    if (lockRow && lockRow.expiresAt > now) {
      const [holder] = await this.db
        .select({ name: user.name })
        .from(user)
        .innerJoin(members, eq(members.userId, user.id))
        .where(and(eq(user.id, lockRow.userId), eq(members.workspaceId, scope.workspaceId)))
        .limit(1);
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
      tags: cardTags,
      subtasks: subtasks.map((s) => ({
        id: s.id,
        cardId: s.cardId,
        title: s.title,
        completed: s.completed,
        position: s.position,
        createdAt: s.createdAt,
      })),
      lock,
    };
  }

  async updateGuarded(args: UpdateCardMutation): Promise<boolean> {
    const { cardId, scope, data, assigneeIds, tagIds, title, now } = args;
    const result = await this.withWorkspaceWrite(scope, async (tx) => {
      const [source] = await tx.select({ notepadId: cards.notepadId, projectId: projects.id })
        .from(cards).innerJoin(boards, eq(boards.id, cards.boardId))
        .innerJoin(projects, eq(projects.id, boards.projectId))
        .innerJoin(boardColumns, eq(boardColumns.id, cards.columnId))
        .innerJoin(notepads, eq(notepads.id, cards.notepadId))
        .where(and(eq(cards.id, cardId), eq(boards.workspaceId, scope.workspaceId),
          eq(projects.workspaceId, scope.workspaceId), eq(notepads.workspaceId, scope.workspaceId),
          eq(notepads.projectId, projects.id), isNull(boards.deletedAt), isNull(notepads.deletedAt)));
      if (!source) return false;
      if (assigneeIds !== undefined) {
        const unique = [...new Set(assigneeIds)];
        const [membersCount] = unique.length ? await tx.select({ count: sql<number>`count(*)` }).from(members)
          .where(and(eq(members.workspaceId, scope.workspaceId), inArray(members.userId, unique))) : [{ count: 0 }];
        if (Number(membersCount.count) !== unique.length) return false;
        await tx.delete(cardAssignees).where(eq(cardAssignees.cardId, cardId));
        if (unique.length) await tx.insert(cardAssignees).values(unique.map((userId) => ({ cardId, userId })));
        const added = args.assignmentNotifications ?? [];
        for (const target of added) {
          if (unique.includes(target.userId)) await tx.insert(notifications).values({
            id: target.id, workspaceId: scope.workspaceId, userId: target.userId,
            type: 'assignment', actorId: scope.actorUserId, notepadId: source.notepadId,
            cardId, readAt: null, createdAt: now,
          }).onConflictDoNothing();
        }
      }
      if (tagIds !== undefined) {
        const unique = [...new Set(tagIds)];
        const [tagsCount] = unique.length ? await tx.select({ count: sql<number>`count(*)` }).from(tags)
          .where(and(eq(tags.projectId, source.projectId), inArray(tags.id, unique))) : [{ count: 0 }];
        if (Number(tagsCount.count) !== unique.length) return false;
        await tx.delete(notepadTags).where(eq(notepadTags.notepadId, source.notepadId));
        if (unique.length) await tx.insert(notepadTags).values(unique.map((tagId) => ({ notepadId: source.notepadId, tagId })));
      }
      if (Object.keys(data).length) await tx.update(cards).set(data).where(eq(cards.id, cardId));
      if (title) await tx.update(notepads).set({ title: title.value, updatedAt: now }).where(eq(notepads.id, source.notepadId));
      return true;
    });
    return result === true;
  }

  async moveGuarded(id: string, columnId: string, position: string, scope: CardMutationScope): Promise<boolean> {
    return (await this.withWorkspaceWrite(scope, async (tx) => {
      const [source] = await tx.select({ id: cards.id, notepadId: cards.notepadId }).from(cards)
        .innerJoin(boards, eq(boards.id, cards.boardId)).innerJoin(projects, eq(projects.id, boards.projectId))
        .innerJoin(notepads, eq(notepads.id, cards.notepadId))
        .innerJoin(boardColumns, and(eq(boardColumns.boardId, boards.id), eq(boardColumns.id, columnId)))
        .where(and(eq(cards.id, id), eq(boardColumns.id, columnId), eq(boards.workspaceId, scope.workspaceId),
          eq(projects.workspaceId, scope.workspaceId), eq(notepads.workspaceId, scope.workspaceId),
          eq(notepads.projectId, projects.id), isNull(boards.deletedAt), isNull(notepads.deletedAt)));
      if (!source) return false;
      await tx.update(cards).set({ columnId, position }).where(eq(cards.id, id));
      return true;
    })) === true;
  }

  async createSubtaskGuarded(data: CreateSubtaskData, scope: CardMutationScope): Promise<CardSubtask | null> {
    const result = await this.withWorkspaceWrite(scope, async (tx) => {
      const [source] = await tx.select({ id: cards.id }).from(cards).innerJoin(boards, eq(boards.id, cards.boardId))
        .innerJoin(projects, eq(projects.id, boards.projectId)).innerJoin(notepads, eq(notepads.id, cards.notepadId))
        .where(and(eq(cards.id, data.cardId), eq(boards.workspaceId, scope.workspaceId),
          eq(projects.workspaceId, scope.workspaceId), eq(notepads.workspaceId, scope.workspaceId),
          eq(notepads.projectId, projects.id), isNull(boards.deletedAt), isNull(notepads.deletedAt)));
      if (!source) return null;
      const [created] = await tx.insert(cardSubtasks).values(data).returning();
      return created ?? null;
    });
    return result ?? null;
  }

  async updateSubtaskGuarded(id: string, cardId: string, data: UpdateSubtaskData, scope: CardMutationScope): Promise<boolean> {
    return (await this.withWorkspaceWrite(scope, async (tx) => {
      const [row] = await tx.select({ subtaskId: cardSubtasks.id }).from(cardSubtasks)
        .innerJoin(cards, eq(cards.id, cardSubtasks.cardId)).innerJoin(boards, eq(boards.id, cards.boardId))
        .innerJoin(projects, eq(projects.id, boards.projectId)).innerJoin(notepads, eq(notepads.id, cards.notepadId))
        .where(and(eq(cardSubtasks.id, id), eq(cardSubtasks.cardId, cardId), eq(boards.workspaceId, scope.workspaceId),
          eq(projects.workspaceId, scope.workspaceId), eq(notepads.workspaceId, scope.workspaceId),
          eq(notepads.projectId, projects.id), isNull(boards.deletedAt), isNull(notepads.deletedAt)));
      if (!row) return false;
      await tx.update(cardSubtasks).set(data).where(eq(cardSubtasks.id, id));
      return true;
    })) === true;
  }

  async deleteSubtaskGuarded(id: string, cardId: string, scope: CardMutationScope): Promise<boolean> {
    return (await this.withWorkspaceWrite(scope, async (tx) => {
      const [row] = await tx.select({ id: cardSubtasks.id }).from(cardSubtasks)
        .innerJoin(cards, eq(cards.id, cardSubtasks.cardId)).innerJoin(boards, eq(boards.id, cards.boardId))
        .innerJoin(projects, eq(projects.id, boards.projectId)).innerJoin(notepads, eq(notepads.id, cards.notepadId))
        .where(and(eq(cardSubtasks.id, id), eq(cardSubtasks.cardId, cardId), eq(boards.workspaceId, scope.workspaceId),
          eq(projects.workspaceId, scope.workspaceId), eq(notepads.workspaceId, scope.workspaceId),
          eq(notepads.projectId, projects.id), isNull(boards.deletedAt), isNull(notepads.deletedAt)));
      if (!row) return false;
      await tx.delete(cardSubtasks).where(eq(cardSubtasks.id, id));
      return true;
    })) === true;
  }

  // Subtasks
  async listSubtasks(scope: ProjectScope, cardId: string): Promise<CardSubtask[]> {
    return this.db
      .select()
      .from(cardSubtasks)
      .where(and(eq(cardSubtasks.cardId, cardId), cardInProjectScope(scope, cardId)))
      .orderBy(cardSubtasks.position);
  }

  // Assignees
  async listAssignees(scope: ProjectScope, cardId: string): Promise<CardAssignee[]> {
    return this.db
      .select({
        cardId: cardAssignees.cardId,
        userId: cardAssignees.userId,
        name: user.name,
        image: user.image,
      })
      .from(cardAssignees)
      .innerJoin(user, eq(cardAssignees.userId, user.id))
      .where(and(eq(cardAssignees.cardId, cardId), cardInProjectScope(scope, cardId)));
  }

  async validateAssignees(workspaceId: string, userIds: string[]): Promise<{ userId: string }[]> {
    const result = await this.db
      .select({ userId: members.userId })
      .from(members)
      .where(and(eq(members.workspaceId, workspaceId), inArray(members.userId, userIds)));
    return result;
  }

  // Tags (delegated to notepad tags since cards are notepads with kind='card')
  async listTagIds(scope: ProjectScope, notepadId: string): Promise<string[]> {
    const result = await this.db
      .select({ tagId: notepadTags.tagId })
      .from(notepadTags)
      .innerJoin(notepads, eq(notepads.id, notepadTags.notepadId))
      .innerJoin(
        projects,
        and(eq(projects.id, notepads.projectId), eq(projects.workspaceId, notepads.workspaceId)),
      )
      .innerJoin(tags, and(eq(tags.id, notepadTags.tagId), eq(tags.projectId, notepads.projectId)))
      .where(and(
        eq(notepadTags.notepadId, notepadId),
        eq(notepads.workspaceId, scope.workspaceId),
        eq(notepads.projectId, scope.projectId),
      ));
    return result.map((r) => r.tagId);
  }

  // Comments
  async listComments(scope: ProjectScope, cardId: string): Promise<Comment[]> {
    return this.db
      .select({
        id: cardComments.id,
        cardId: cardComments.cardId,
        userId: cardComments.userId,
        content: cardComments.content,
        createdAt: cardComments.createdAt,
        updatedAt: cardComments.updatedAt,
        name: user.name,
        image: user.image,
      })
      .from(cardComments)
      .innerJoin(user, eq(cardComments.userId, user.id))
      .where(and(eq(cardComments.cardId, cardId), cardInProjectScope(scope, cardId)))
      .orderBy(asc(cardComments.createdAt));
  }

  async createCommentGuarded(args: CreateCommentMutation): Promise<Comment | null> {
    const { data, scope, now } = args;
    const result = await this.withWorkspaceWrite(scope, async (tx) => {
      const [source] = await tx.select({ id: cards.id, notepadId: cards.notepadId }).from(cards)
        .innerJoin(boards, eq(boards.id, cards.boardId)).innerJoin(projects, eq(projects.id, boards.projectId))
        .innerJoin(notepads, eq(notepads.id, cards.notepadId)).innerJoin(boardColumns, eq(boardColumns.id, cards.columnId))
        .where(and(eq(cards.id, data.cardId), eq(boards.workspaceId, scope.workspaceId),
          eq(projects.workspaceId, scope.workspaceId), eq(notepads.workspaceId, scope.workspaceId),
          eq(notepads.projectId, projects.id), eq(cardComments.userId, scope.actorUserId),
          isNull(boards.deletedAt), isNull(notepads.deletedAt)));
      if (!source) return null;
      const [created] = await tx.insert(cardComments).values(data).returning();
      if (!created) return null;
      for (const target of args.mentionNotifications) {
        if (target.userId === scope.actorUserId) continue;
        const [member] = await tx.select({ userId: members.userId }).from(members)
          .where(and(eq(members.workspaceId, scope.workspaceId), eq(members.userId, target.userId)));
        if (member) await tx.insert(notifications).values({
          id: target.id, workspaceId: scope.workspaceId, userId: target.userId, type: 'mention',
          actorId: scope.actorUserId, notepadId: source.notepadId, cardId: data.cardId,
          readAt: null, createdAt: now,
        }).onConflictDoNothing();
      }
      const [comment] = await tx.select({
        id: cardComments.id, cardId: cardComments.cardId, userId: cardComments.userId,
        content: cardComments.content, createdAt: cardComments.createdAt, updatedAt: cardComments.updatedAt,
        name: user.name, image: user.image,
      }).from(cardComments).innerJoin(user, eq(user.id, cardComments.userId))
        .where(eq(cardComments.id, created.id)).limit(1);
      return comment ?? null;
    });
    return result ?? null;
  }

  async deleteCommentGuarded(id: string, cardId: string, scope: CardMutationScope): Promise<CommentDeleteResult> {
    const result = await this.withWorkspaceWrite(scope, async (tx) => {
      const [comment] = await tx.select({ id: cardComments.id, userId: cardComments.userId })
        .from(cardComments).innerJoin(cards, eq(cards.id, cardComments.cardId))
        .innerJoin(boards, eq(boards.id, cards.boardId)).innerJoin(projects, eq(projects.id, boards.projectId))
        .innerJoin(notepads, eq(notepads.id, cards.notepadId)).innerJoin(boardColumns, eq(boardColumns.id, cards.columnId))
        .where(and(eq(cardComments.id, id), eq(cardComments.cardId, cardId), eq(boards.workspaceId, scope.workspaceId),
          eq(projects.workspaceId, scope.workspaceId), eq(notepads.workspaceId, scope.workspaceId),
          eq(notepads.projectId, projects.id), isNull(boards.deletedAt), isNull(notepads.deletedAt)));
      if (!comment) return 'not_found' as const;
      const [actor] = await tx.select({ role: members.role }).from(members)
        .where(and(eq(members.workspaceId, scope.workspaceId), eq(members.userId, scope.actorUserId)));
      if (!actor || (actor.role === 'viewer') ||
        (comment.userId !== scope.actorUserId && actor.role !== 'owner')) return 'forbidden' as const;
      await tx.delete(cardComments).where(eq(cardComments.id, id));
      return 'deleted' as const;
    });
    return result ?? 'forbidden';
  }

  async getComment(scope: ProjectScope, id: string, cardId: string): Promise<Comment | null> {
    const result = await this.db
      .select({
        id: cardComments.id,
        cardId: cardComments.cardId,
        userId: cardComments.userId,
        content: cardComments.content,
        createdAt: cardComments.createdAt,
        updatedAt: cardComments.updatedAt,
        name: user.name,
        image: user.image,
      })
      .from(cardComments)
      .innerJoin(user, eq(cardComments.userId, user.id))
      .where(and(
        eq(cardComments.id, id),
        eq(cardComments.cardId, cardId),
        cardInProjectScope(scope, cardId),
      ))
      .limit(1);
    return result[0] ?? null;
  }

  // Queries
  async listByColumn(scope: ProjectScope, columnId: string): Promise<Card[]> {
    const result = await this.db
      .select({
        id: cards.id,
        boardId: cards.boardId,
        columnId: cards.columnId,
        notepadId: cards.notepadId,
        position: cards.position,
        priority: cards.priority,
        dueDate: cards.dueDate,
        createdAt: cards.createdAt,
        projectId: projects.id,
      })
      .from(cards)
      .innerJoin(notepads, eq(cards.notepadId, notepads.id))
      .innerJoin(boards, eq(cards.boardId, boards.id))
      .innerJoin(projects, eq(boards.projectId, projects.id))
      .innerJoin(boardColumns, eq(cards.columnId, boardColumns.id))
      .where(and(
        eq(cards.columnId, columnId),
        eq(projects.workspaceId, scope.workspaceId),
        eq(projects.id, scope.projectId),
        liveCardSource(sourceTables),
      ))
      .orderBy(cards.position);
    return result;
  }

  async getMyTasks(
    workspaceId: string,
    userId: string,
    filters: MyTasksFilters,
  ): Promise<MyTaskItem[]> {
    const whereConditions = [
      eq(cardAssignees.userId, userId),
      eq(projects.workspaceId, workspaceId),
      liveCardSource(sourceTables)!,
      isNull(projects.archivedAt),
    ];
    if (filters.projectId) {
      whereConditions.push(eq(projects.id, filters.projectId));
    }

    const isCompletedColumn = (columnName: string) =>
      /done|completed|closed|shipped/i.test(columnName);

    const result = await this.db
      .select({
        id: cards.id,
        notepadId: cards.notepadId,
        boardId: cards.boardId,
        columnId: cards.columnId,
        projectId: projects.id,
        title: notepads.title,
        dueDate: cards.dueDate,
        priority: cards.priority,
        createdAt: notepads.createdAt,
        boardName: boards.name,
        columnName: boardColumns.name,
        projectName: projects.name,
        projectIcon: projects.icon,
        projectColor: projects.color,
        tags: sql<{ id: string; name: string; color: string | null }[]>`jsonb_agg(
          jsonb_build_object('id', ${tags.id}, 'name', ${tags.name}, 'color', ${tags.color})
        )`.as('tags'),
      })
      .from(cards)
      .innerJoin(notepads, eq(cards.notepadId, notepads.id))
      .innerJoin(boards, eq(cards.boardId, boards.id))
      .innerJoin(boardColumns, eq(cards.columnId, boardColumns.id))
      .innerJoin(projects, eq(boards.projectId, projects.id))
      .innerJoin(cardAssignees, eq(cards.id, cardAssignees.cardId))
      .leftJoin(notepadTags, eq(notepads.id, notepadTags.notepadId))
      .leftJoin(tags, and(eq(notepadTags.tagId, tags.id), eq(tags.projectId, notepads.projectId)))
      .where(and(...whereConditions))
      .groupBy(
        cards.id,
        cards.notepadId,
        cards.boardId,
        cards.columnId,
        projects.id,
        notepads.title,
        cards.dueDate,
        cards.priority,
        notepads.createdAt,
        boards.name,
        boardColumns.name,
        projects.name,
        projects.icon,
        projects.color,
      );

    const status = filters.status ?? 'all';
    const filtered =
      status === 'all'
        ? result
        : result.filter((r) => {
            const completed = isCompletedColumn(r.columnName);
            return status === 'completed' ? completed : !completed;
          });

    return filtered.map((r) => ({
      ...r,
      isCompleted: isCompletedColumn(r.columnName),
      tags: r.tags.filter((t: { id: string | null }) => t.id !== null),
    }));
  }

  async getCardsSummary(scope: ProjectScope, cardIds: string[]): Promise<CardSummary[]> {
    if (cardIds.length === 0) return [];
    const result = await this.db
      .select({
        id: cards.id,
        notepadId: cards.notepadId,
        title: notepads.title,
        boardId: cards.boardId,
        boardName: boards.name,
        columnId: cards.columnId,
        columnName: boardColumns.name,
        priority: cards.priority,
        dueDate: cards.dueDate,
        assignees: sql<CardSummary['assignees']>`coalesce(jsonb_agg(
          jsonb_build_object('userId', ${user.id}, 'name', ${user.name}, 'image', ${user.image})
        ) FILTER (WHERE ${user.id} IS NOT NULL), '[]'::jsonb)`.as('assignees'),
      })
      .from(cards)
      .innerJoin(notepads, eq(cards.notepadId, notepads.id))
      .innerJoin(boards, eq(cards.boardId, boards.id))
      .innerJoin(
        boardColumns,
        and(eq(cards.columnId, boardColumns.id), eq(boardColumns.boardId, cards.boardId)),
      )
      .innerJoin(projects, eq(boards.projectId, projects.id))
      .leftJoin(cardAssignees, eq(cards.id, cardAssignees.cardId))
      .leftJoin(
        members,
        and(eq(members.userId, cardAssignees.userId), eq(members.workspaceId, scope.workspaceId)),
      )
      .leftJoin(user, eq(members.userId, user.id))
      .where(
        and(
          inArray(cards.id, cardIds),
          eq(projects.workspaceId, scope.workspaceId),
          eq(projects.id, scope.projectId),
          liveCardSource(sourceTables),
        ),
      )
      .groupBy(
        cards.id,
        cards.notepadId,
        notepads.title,
        cards.boardId,
        boards.name,
        cards.columnId,
        boardColumns.name,
        cards.priority,
        cards.dueDate,
      );

    return result;
  }

  // Search/suggest
  async findByPattern(
    scope: ProjectScope,
    pattern: string,
    limit: number,
  ): Promise<{ id: string; title: string; boardName: string; priority: CardPriority | null }[]> {
    return this.db
      .select({
        id: cards.id,
        title: notepads.title,
        boardName: boards.name,
        priority: cards.priority,
      })
      .from(cards)
      .innerJoin(notepads, eq(cards.notepadId, notepads.id))
      .innerJoin(boards, eq(cards.boardId, boards.id))
      .innerJoin(boardColumns, eq(cards.columnId, boardColumns.id))
      .innerJoin(projects, eq(boards.projectId, projects.id))
      .where(
        and(
          eq(projects.id, scope.projectId),
          eq(projects.workspaceId, scope.workspaceId),
          liveCardSource(sourceTables),
          sql`${notepads.title} ILIKE ${`%${pattern}%`}`,
        ),
      )
      .limit(limit);
  }
}

import { nanoid } from 'nanoid';
import type {
  ICardRepository,
  CardPlan,
  INotepadRepository,
  ITagRepository,
  IBoardRepository,
  CardPriority,
  MyTasksFilters,
  MyTaskItem,
  CardSummary,
  ProjectScope,
  CardSubtask,
  CreateSubtaskData,
  UpdateSubtaskData,
  UpdateCardData,
  CardWithDetails,
  INotificationRepository,
} from '../infrastructure/types';
import { notFound, badRequest, conflict, forbidden, rethrowAmbiguousDeleteGroup } from './errors';
import { positionAfterLast, positionBetween } from './utils/ordering';
import { extractPlainText } from '../../shared/extract';

export interface CreateCardInput {
  workspaceId: string;
  projectId: string;
  actorId: string;
  boardId: string;
  columnId: string;
  title: string;
  priority?: CardPriority | null;
  dueDate?: number | null;
  assigneeIds?: string[];
  tagIds?: string[];
  notepad?: { mode: 'new' } | { mode: 'existing'; id: string };
}

export interface CreatedCard {
  cardId: string;
  notepadId: string;
  linkedNotepadId: string | null;
}

export type { CardPlan } from '../infrastructure/types';

export class CardService {
  constructor(
    private readonly repos: {
      cards: ICardRepository;
      notepads: INotepadRepository;
      tags: ITagRepository;
      boards: IBoardRepository;
      notifications: INotificationRepository;
    },
  ) {}

  async createCard(input: CreateCardInput): Promise<CreatedCard> {
    const scope = { workspaceId: input.workspaceId, projectId: input.projectId };
    const board = await this.repos.boards.findByIdInScope(scope, input.boardId);
    if (!board || board.deletedAt !== null) {
      throw notFound('not_found', 'Board not found');
    }
    const column = await this.repos.boards.findColumnByIdInScope(scope, input.columnId);
    if (!column || column.boardId !== board.id) {
      throw notFound('not_found', 'Column not found');
    }

    const assigneeIds = [...new Set(input.assigneeIds ?? [])];
    if (assigneeIds.length > 0) {
      const members = await this.validateAssignees(input.workspaceId, assigneeIds);
      if (members.length !== assigneeIds.length) {
        throw badRequest('invalid_assignees', 'Assignees must be workspace members');
      }
    }

    const tagIds = [...new Set(input.tagIds ?? [])];
    if (tagIds.length > 0) {
      const tags = await this.validateTags(scope, tagIds);
      if (tags.length !== tagIds.length) {
        throw badRequest('invalid_tags', 'Tags must belong to this project');
      }
    }

    let linkedNotepad: CardPlan['linkedNotepad'] = null;
    let content = '[]';
    if (input.notepad?.mode === 'existing') {
      const linked = await this.repos.notepads.findByIdInScope(scope, input.notepad.id);
      if (
        !linked ||
        linked.projectId !== board.projectId ||
        linked.workspaceId !== input.workspaceId ||
        linked.kind !== 'notepad' ||
        linked.deletedAt !== null
      ) {
        throw notFound('not_found', 'Notepad not found');
      }
      linkedNotepad = {
        id: linked.id,
        position: linked.position,
        title: linked.title,
        mode: 'existing',
      };
      content = linkBlockBody(linked.id);
    } else if (input.notepad?.mode === 'new') {
      linkedNotepad = {
        id: nanoid(),
        position: await this.repos.notepads.getLastRootNotepadPosition({
          workspaceId: board.workspaceId,
          projectId: board.projectId,
        }),
        title: input.title.trim() || 'Untitled',
        mode: 'new',
      };
      content = linkBlockBody(linkedNotepad.id);
    }

    const title = input.title.trim() || 'Untitled';
    const plan: CardPlan = {
      workspaceId: input.workspaceId,
      projectId: board.projectId,
      boardId: board.id,
      columnId: column.id,
      actorId: input.actorId,
      cardId: nanoid(),
      notepadId: nanoid(),
      title,
      content,
      plainText: extractPlainText(content),
      priority: input.priority ?? null,
      dueDate: input.dueDate ?? null,
      assigneeIds,
      tagIds,
      assignmentNotifications: assigneeIds
        .filter((userId) => userId !== input.actorId)
        .map((userId) => ({ id: nanoid(), userId })),
      cardPosition: await this.lastCardPosition(column.id, {
        workspaceId: input.workspaceId,
        projectId: board.projectId,
      }),
      linkedNotepad,
      now: Date.now(),
    };

    if (!(await this.repos.cards.createFromPlan(plan))) {
      throw forbidden('forbidden', 'Editor access changed while creating the card');
    }

    return {
      cardId: plan.cardId,
      notepadId: plan.notepadId,
      linkedNotepadId: linkedNotepad?.id ?? null,
    };
  }

  async getCard(scope: ProjectScope, cardId: string): Promise<CardWithDetails> {
    const scopedCard = await this.repos.cards.findByIdInScope(scope, cardId);
    if (!scopedCard || scopedCard.deletedAt !== null) throw notFound('not_found', 'Card not found');
    const card = await this.repos.cards.getCardWithDetails(scope, cardId);
    if (!card) throw notFound('not_found', 'Card not found');
    return card;
  }

  async moveCard(
    scope: ProjectScope,
    actorId: string,
    cardId: string,
    columnId: string,
    afterId?: string | null,
  ): Promise<{ columnId: string; position: string }> {
    const { workspaceId } = scope;
    const card = await this.repos.cards.findByIdInScope(scope, cardId);
    if (!card) throw notFound('not_found', 'Card not found');
    if (card.deletedAt !== null && card.deletedAt !== undefined) {
      throw badRequest('card_deleted', 'Cannot modify a deleted card');
    }

    const column = await this.repos.boards.findColumnByIdInScope(scope, columnId);
    if (!column || column.boardId !== card.boardId) {
      throw notFound('not_found', 'Destination column not found on this board');
    }

    // Get cards in destination column for positioning
    // This requires a repository method to list cards by column
    const columnCards = await this.repos.cards.listByColumn(
      { workspaceId, projectId: card.projectId },
      columnId,
    );
    const others = columnCards.filter((c) => c.id !== cardId);

    let newPosition: string;
    if (!afterId) {
      const next = others[0]?.position ?? null;
      newPosition = positionBetween(null, next);
    } else {
      const afterIndex = others.findIndex((c) => c.id === afterId);
      if (afterIndex === -1) throw badRequest('invalid_after_id', 'afterId not found in column');
      const prev = others[afterIndex]!.position;
      const next = others[afterIndex + 1]?.position ?? null;
      newPosition = positionBetween(prev, next);
    }

    if (!(await this.repos.cards.moveGuarded(cardId, columnId, newPosition, {
      workspaceId,
      actorUserId: actorId,
      minimumRole: 'editor',
    }))) throw forbidden('forbidden', 'Editor access changed while moving the card');
    return { columnId, position: newPosition };
  }

  async updateCard(
    scope: ProjectScope,
    cardId: string,
    updates: {
      title?: string;
      priority?: CardPriority | null;
      dueDate?: number | null;
      assigneeIds?: string[];
      tagIds?: string[];
    },
    actorId: string,
  ): Promise<{ ok: true; cardId: string }> {
    const { workspaceId } = scope;
    const card = await this.repos.cards.findByIdInScope(scope, cardId);
    if (!card) throw notFound('not_found', 'Card not found');
    if (card.deletedAt !== null && card.deletedAt !== undefined) {
      throw badRequest('card_deleted', 'Cannot modify a deleted card');
    }

    const now = Date.now();

    // Assignees validation & update
    if (updates.assigneeIds !== undefined) {
      const cleanAssignees = [...new Set(updates.assigneeIds)];
      if (cleanAssignees.length > 0) {
        const members = await this.validateAssignees(workspaceId, cleanAssignees);
        if (members.length !== cleanAssignees.length) {
          throw badRequest('invalid_assignees', 'Assignees must be workspace members');
        }
      }

      updates.assigneeIds = cleanAssignees;
    }

    // Tags validation & update
    if (updates.tagIds !== undefined) {
      const cleanTags = [...new Set(updates.tagIds)];
      if (cleanTags.length > 0) {
        const tags = await this.validateTags(scope, cleanTags);
        if (tags.length !== cleanTags.length) {
          throw badRequest('invalid_tags', 'Tags must belong to this project');
        }
      }
      updates.tagIds = cleanTags;
    }

    // Priority and Due Date
    const cardUpdates: UpdateCardData = {};
    if (updates.priority !== undefined) cardUpdates.priority = updates.priority ?? null;
    if (updates.dueDate !== undefined) cardUpdates.dueDate = updates.dueDate ?? null;

    const newTitle = updates.title === undefined ? undefined : updates.title.trim() || 'Untitled';
    const written = await this.repos.cards.updateGuarded({
      cardId,
      scope: { workspaceId, actorUserId: actorId, minimumRole: 'editor' },
      data: cardUpdates,
      assigneeIds: updates.assigneeIds,
      tagIds: updates.tagIds,
      title: newTitle === undefined ? undefined : {
        value: newTitle,
        plainText: extractPlainText(card.content ?? ''),
      },
      assignmentNotifications: (updates.assigneeIds ?? [])
        .filter((userId) => userId !== actorId)
        .map((userId) => ({ id: nanoid(), userId })),
      now,
    });
    if (!written) throw forbidden('forbidden', 'Editor access changed while updating the card');

    return { ok: true, cardId };
  }

  async deleteCard(scope: ProjectScope, actorId: string, cardId: string): Promise<{ ok: true; cardId: string }> {
    const card = await this.repos.cards.findByIdInScope(scope, cardId);
    if (!card || (card.deletedAt !== null && card.deletedAt !== undefined)) {
      throw notFound('not_found', 'Card not found');
    }

    const now = Date.now();
    // Invariant I5: Card and its notepad always have the same soft-delete state
    const deleted = await this.repos.notepads.softDelete(card.notepadId, now, {
      workspaceId: scope.workspaceId, projectId: scope.projectId, actorUserId: actorId, minimumRole: 'editor',
    });
    if (!deleted) throw forbidden('forbidden', 'Editor access changed while deleting the card');

    return { ok: true, cardId };
  }

  async restoreCard(scope: ProjectScope, actorId: string, cardId: string): Promise<{ ok: true; cardId: string }> {
    const card = await this.repos.cards.findByIdInScope(scope, cardId);
    if (!card) throw notFound('not_found', 'Deleted card not found');

    const notepad = await this.repos.notepads.findByIdInScope(scope, card.notepadId);
    if (!notepad || notepad.deletedAt === null) {
      throw notFound('not_found', 'Deleted card not found');
    }

    try {
      const restored = await this.repos.notepads.restore(card.notepadId, notepad.deletedAt, {
        workspaceId: scope.workspaceId, projectId: scope.projectId, actorUserId: actorId, minimumRole: 'editor',
      });
      if (!restored?.some((item) => item.id === card.notepadId)) {
        throw conflict('deletion_changed', 'This card changed while it was being restored');
      }
    } catch (error) {
      rethrowAmbiguousDeleteGroup(error);
    }

    return { ok: true, cardId };
  }

  async permanentDeleteCard(
    scope: ProjectScope,
    actorId: string,
    cardId: string,
  ): Promise<{ ok: true; cardId: string }> {
    const card = await this.repos.cards.findByIdInScope(scope, cardId);
    if (!card) throw notFound('not_found', 'Deleted card not found in trash');

    const notepad = await this.repos.notepads.findByIdInScope(scope, card.notepadId);
    if (!notepad || notepad.deletedAt === null) {
      throw notFound('not_found', 'Deleted card not found in trash');
    }

    const removed = await this.repos.notepads.hardDelete(card.notepadId, {
      workspaceId: scope.workspaceId, projectId: scope.projectId, actorUserId: actorId, minimumRole: 'owner',
    });
    if (!removed) throw forbidden('forbidden', 'Owner access changed while deleting the card');

    return { ok: true, cardId };
  }

  async getCardsSummary(scope: ProjectScope, cardIds: string[]): Promise<CardSummary[]> {
    if (cardIds.length === 0) return [];
    const cappedIds = cardIds.slice(0, 500);
    return this.repos.cards.getCardsSummary(scope, cappedIds);
  }

  async getMyTasks(
    workspaceId: string,
    userId: string,
    filters: MyTasksFilters,
  ): Promise<MyTaskItem[]> {
    return this.repos.cards.getMyTasks(workspaceId, userId, filters);
  }

  // ---------------------------------------------------------------------------
  // Subtasks
  // ---------------------------------------------------------------------------
  async listSubtasks(scope: ProjectScope, cardId: string): Promise<CardSubtask[]> {
    await this.requireCardInScope(scope, cardId);
    return this.repos.cards.listSubtasks(scope, cardId);
  }

  async createSubtask(scope: ProjectScope, actorId: string, cardId: string, title: string): Promise<CardSubtask> {
    await this.requireCardInScope(scope, cardId);

    const [last] = await this.repos.cards
      .listSubtasks(scope, cardId)
      .then((s) => [s[s.length - 1]])
      .catch(() => [null as any]);
    const row: CreateSubtaskData = {
      id: nanoid(),
      cardId,
      title: title.trim() || 'Untitled',
      completed: false,
      position: positionAfterLast(last?.position ?? null),
      createdAt: Date.now(),
    };
    const created = await this.repos.cards.createSubtaskGuarded(row, {
      workspaceId: scope.workspaceId, actorUserId: actorId, minimumRole: 'editor',
    });
    if (!created) throw forbidden('forbidden', 'Editor access changed while creating the subtask');
    return created;
  }

  async updateSubtask(
    scope: ProjectScope,
    actorId: string,
    cardId: string,
    subtaskId: string,
    updates: { title?: string; completed?: boolean; afterId?: string | null },
  ): Promise<{ ok: true; subtaskId: string }> {
    await this.requireCardInScope(scope, cardId);

    const subtasks = await this.repos.cards.listSubtasks(
      scope,
      cardId,
    );
    const subtask = subtasks.find((s) => s.id === subtaskId);
    if (!subtask) throw notFound('not_found', 'Subtask not found');

    const patch: UpdateSubtaskData = {};
    if (updates.title !== undefined) patch.title = updates.title.trim() || 'Untitled';
    if (updates.completed !== undefined) patch.completed = updates.completed;

    if (updates.afterId !== undefined) {
      const others = subtasks.filter((s) => s.id !== subtaskId);
      let newPosition: string;
      if (!updates.afterId) {
        newPosition = positionBetween(null, others[0]?.position ?? null);
      } else {
        const idx = others.findIndex((s) => s.id === updates.afterId);
        if (idx === -1) throw badRequest('invalid_after_id', 'afterId not found in subtask list');
        newPosition = positionBetween(others[idx]!.position, others[idx + 1]?.position ?? null);
      }
      patch.position = newPosition;
    }

    if (Object.keys(patch).length > 0) {
      if (!(await this.repos.cards.updateSubtaskGuarded(subtaskId, cardId, patch, {
        workspaceId: scope.workspaceId, actorUserId: actorId, minimumRole: 'editor',
      }))) throw forbidden('forbidden', 'Editor access changed while updating the subtask');
    }
    return { ok: true, subtaskId };
  }

  async deleteSubtask(
    scope: ProjectScope,
    actorId: string,
    cardId: string,
    subtaskId: string,
  ): Promise<{ ok: true; subtaskId: string }> {
    await this.requireCardInScope(scope, cardId);
    const subtasks = await this.repos.cards.listSubtasks(
      scope,
      cardId,
    );
    if (!subtasks.find((s) => s.id === subtaskId)) throw notFound('not_found', 'Subtask not found');

    if (!(await this.repos.cards.deleteSubtaskGuarded(subtaskId, cardId, {
      workspaceId: scope.workspaceId, actorUserId: actorId, minimumRole: 'editor',
    }))) throw forbidden('forbidden', 'Editor access changed while deleting the subtask');
    return { ok: true, subtaskId };
  }

  private async requireCardInScope(scope: ProjectScope, cardId: string) {
    const card = await this.repos.cards.findByIdInScope(scope, cardId);
    if (!card || (card.deletedAt !== null && card.deletedAt !== undefined)) {
      throw notFound('not_found', 'Card not found');
    }
    return card;
  }

  private async validateAssignees(
    workspaceId: string,
    userIds: string[],
  ): Promise<{ userId: string }[]> {
    // This would use the member repository to validate
    // For now, we'll assume the repository has this method
    return this.repos.cards.validateAssignees(workspaceId, userIds);
  }

  private async validateTags(scope: ProjectScope, tagIds: string[]): Promise<{ id: string }[]> {
    return this.repos.tags.validateByProject(scope, tagIds);
  }

  private async lastCardPosition(columnId: string, scope: ProjectScope): Promise<string> {
    const cards = await this.repos.cards.listByColumn(scope, columnId);
    return positionAfterLast(cards[cards.length - 1]?.position ?? null);
  }
}

function linkBlockBody(notepadId: string): string {
  return JSON.stringify([
    { id: nanoid(), type: 'notepadLink', props: { notepadId }, content: [], children: [] },
  ]);
}

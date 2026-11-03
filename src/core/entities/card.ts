import type { CardPlan, CreateNotepadData } from '../infrastructure/types';

/** Pure row projection used by every card persistence adapter. */
export function cardCreationRows(plan: CardPlan) {
  const base = {
    workspaceId: plan.workspaceId,
    projectId: plan.projectId,
    parentId: null,
    version: 1,
    isFavorite: false,
    createdBy: plan.actorId,
    createdAt: plan.now,
    updatedAt: plan.now,
  };
  const notepads: Array<CreateNotepadData & { plainText: string }> = [
    {
      ...base,
      id: plan.notepadId,
      kind: 'card',
      title: plan.title,
      content: plan.content,
      plainText: plan.plainText,
      position: 'a0',
    },
  ];
  if (plan.linkedNotepad?.mode === 'new') {
    notepads.unshift({
      ...base,
      id: plan.linkedNotepad.id,
      kind: 'notepad',
      title: plan.linkedNotepad.title,
      content: '[]',
      plainText: '',
      position: plan.linkedNotepad.position,
    });
  }
  return {
    notepads,
    card: {
      id: plan.cardId,
      boardId: plan.boardId,
      columnId: plan.columnId,
      notepadId: plan.notepadId,
      position: plan.cardPosition,
      priority: plan.priority,
      dueDate: plan.dueDate,
      createdAt: plan.now,
    },
    links: plan.linkedNotepad
      ? [
          {
            sourceId: plan.notepadId,
            targetType: 'notepad' as const,
            targetId: plan.linkedNotepad.id,
          },
        ]
      : [],
    assignees: plan.assigneeIds.map((userId) => ({ cardId: plan.cardId, userId })),
    tags: plan.tagIds.map((tagId) => ({ notepadId: plan.notepadId, tagId })),
    notifications: plan.assignmentNotifications.map(({ id, userId }) => ({
      id,
      userId,
      workspaceId: plan.workspaceId,
      type: 'assigned' as const,
      actorId: plan.actorId,
      notepadId: plan.notepadId,
      cardId: plan.cardId,
      readAt: null,
      createdAt: plan.now,
    })),
  };
}

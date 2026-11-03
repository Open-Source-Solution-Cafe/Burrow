import { nanoid } from 'nanoid';
import type {
  IBoardRepository,
  ICardRepository,
  IProjectRepository,
  Board,
  BoardColumn,
  BoardWithDetails,
  BoardMutationScope,
  ProjectScope,
} from '../infrastructure/types';
import { notFound, badRequest, forbidden, rethrowAmbiguousDeleteGroup } from './errors';
import { positionAfterLast, positionBetween } from './utils/ordering';

export interface CreateBoardArgs {
  workspaceId: string;
  actorUserId: string;
  projectId: string;
  name: string;
  icon?: string | null;
}

export class BoardService {
  constructor(
    private readonly repos: {
      boards: IBoardRepository;
      cards?: ICardRepository;
      projects?: IProjectRepository;
    },
  ) {}

  async listBoards(scope: ProjectScope): Promise<Board[]> {
    if (this.repos.projects) {
      const proj = await this.repos.projects.findByIdAndWorkspace(scope.projectId, scope.workspaceId);
      if (!proj) throw notFound('not_found', 'Project not found');
    }
    return this.repos.boards.listByProject(scope);
  }

  async createBoard(args: CreateBoardArgs): Promise<{ id: string; position: string }> {
    if (this.repos.projects) {
      const proj = await this.repos.projects.findByIdAndWorkspace(args.projectId, args.workspaceId);
      if (!proj) throw notFound('not_found', 'Project not found');
    }
    const boards = await this.repos.boards.listByProject({
      workspaceId: args.workspaceId,
      projectId: args.projectId,
    });
    const boardPosition = positionAfterLast(boards[boards.length - 1]?.position ?? null);
    const boardId = nanoid();
    const now = Date.now();

    // Default columns: To do, In progress, Done
    const defaultColumns = [
      { id: nanoid(), name: 'To do', color: '#64748b', position: 'a0', wipLimit: null },
      { id: nanoid(), name: 'In progress', color: '#3b82f6', position: 'a1', wipLimit: null },
      { id: nanoid(), name: 'Done', color: '#10b981', position: 'a2', wipLimit: null },
    ];

    const created = await this.repos.boards.createWithColumns(
      {
        id: boardId,
        workspaceId: args.workspaceId,
        projectId: args.projectId,
        name: args.name.trim() || 'Untitled Board',
        icon: args.icon ?? null,
        position: boardPosition,
        createdAt: now,
        updatedAt: now,
      },
      defaultColumns.map((col) => ({
        id: col.id,
        boardId,
        name: col.name,
        color: col.color,
        position: col.position,
        wipLimit: col.wipLimit,
      })),
      mutationScope(args.workspaceId, args.actorUserId, 'editor'),
    );
    assertWrite(created, 'editor');

    return { id: boardId, position: boardPosition };
  }

  async getBoard(
    scope: ProjectScope,
    boardId: string,
  ): Promise<BoardWithDetails | (Board & { columns: (BoardColumn & { cards: any[] })[] })> {
    const scopedBoard = await this.repos.boards.findByIdInScope(scope, boardId);
    if (!scopedBoard) throw notFound('not_found', 'Board not found');
    if (this.repos.boards.getBoardWithDetails) {
      const board = await this.repos.boards.getBoardWithDetails(scope, boardId);
      if (!board) throw notFound('not_found', 'Board not found');
      return board;
    }

    const columns = await this.repos.boards.listColumns(
      scope,
      boardId,
    );
    return {
      ...scopedBoard,
      columns: columns.map((col) => ({ ...col, cards: [] })),
    };
  }

  async updateBoard(
    scope: ProjectScope,
    actorUserId: string,
    boardId: string,
    updates: { name?: string; icon?: string | null },
  ): Promise<void> {
    const board = await this.repos.boards.findByIdInScope(scope, boardId);
    if (!board || board.deletedAt !== null) throw notFound('not_found', 'Board not found');

    const updated = await this.repos.boards.updateGuarded(boardId, {
      name: updates.name ? updates.name.trim() : undefined,
      icon: updates.icon !== undefined ? updates.icon : undefined,
      updatedAt: Date.now(),
    }, mutationScope(scope.workspaceId, actorUserId, 'editor'));
    assertWrite(updated, 'editor');
  }

  async softDeleteBoard(scope: ProjectScope, actorUserId: string, boardId: string): Promise<void> {
    const board = await this.repos.boards.findByIdInScope(scope, boardId);
    if (!board || board.deletedAt !== null) throw notFound('not_found', 'Board not found');

    const now = Date.now();
    // Soft-deletes board and its card notepads, removing FTS entries
    const deleted = await this.repos.boards.softDeleteGuarded(
      boardId, now, mutationScope(scope.workspaceId, actorUserId, 'editor'),
    );
    assertWrite(deleted, 'editor');
  }

  async restoreBoard(scope: ProjectScope, actorUserId: string, boardId: string): Promise<void> {
    const board = await this.repos.boards.findByIdInScope(scope, boardId);
    if (!board || board.deletedAt === null) {
      throw notFound('not_found', 'Deleted board not found');
    }

    try {
      const restored = await this.repos.boards.restoreGuarded(
        boardId, mutationScope(scope.workspaceId, actorUserId, 'editor'),
      );
      assertWrite(restored, 'editor');
    } catch (error) {
      rethrowAmbiguousDeleteGroup(error);
    }
  }

  async permanentDeleteBoard(scope: ProjectScope, actorUserId: string, boardId: string): Promise<void> {
    const board = await this.repos.boards.findByIdInScope(scope, boardId);
    if (!board || board.deletedAt === null) {
      throw notFound('not_found', 'Deleted board not found in trash');
    }

    const deleted = await this.repos.boards.hardDeleteGuarded(
      boardId, mutationScope(scope.workspaceId, actorUserId, 'owner'),
    );
    assertWrite(deleted, 'owner');
  }

  // ---------------------------------------------------------------------------
  // Columns
  // ---------------------------------------------------------------------------
  async createColumn(
    scope: ProjectScope,
    actorUserId: string,
    boardId: string,
    name: string,
    color?: string | null,
  ): Promise<{ id: string; position: string }> {
    const board = await this.repos.boards.findByIdInScope(scope, boardId);
    if (!board) throw notFound('not_found', 'Board not found');

    const columns = await this.repos.boards.listColumns(
      scope,
      boardId,
    );
    const position = positionAfterLast(columns[columns.length - 1]?.position ?? null);
    const id = nanoid();

    const created = await this.repos.boards.createColumnGuarded({
      id,
      boardId,
      name: name.trim() || 'Untitled Column',
      color: color ?? null,
      position,
      wipLimit: null,
    }, mutationScope(scope.workspaceId, actorUserId, 'editor'));
    assertWrite(created, 'editor');

    return { id, position };
  }

  async updateColumn(
    scope: ProjectScope,
    actorUserId: string,
    columnId: string,
    updates: { name?: string; color?: string | null; wipLimit?: number | null },
  ): Promise<void> {
    // Verify column belongs to a board in the workspace
    const column = await this.repos.boards.findColumnByIdInScope(scope, columnId);
    if (!column) throw notFound('not_found', 'Column not found');

    const updated = await this.repos.boards.updateColumnGuarded(columnId, {
      name: updates.name ? updates.name.trim() : undefined,
      color: updates.color !== undefined ? updates.color : undefined,
      wipLimit: updates.wipLimit !== undefined ? updates.wipLimit : undefined,
    }, mutationScope(scope.workspaceId, actorUserId, 'editor'));
    assertWrite(updated, 'editor');
  }

  async moveColumn(
    scope: ProjectScope,
    actorUserId: string,
    columnId: string,
    afterId?: string | null,
  ): Promise<{ position: string }> {
    const column = await this.repos.boards.findColumnByIdInScope(scope, columnId);
    if (!column) throw notFound('not_found', 'Column not found');

    const board = await this.repos.boards.findByIdInScope(scope, column.boardId);
    if (!board) throw notFound('not_found', 'Board not found');
    const columns = await this.repos.boards.listColumns(
      scope,
      column.boardId,
    );
    const others = columns.filter((c) => c.id !== columnId);

    let newPosition: string;
    if (!afterId) {
      const next = others[0]?.position ?? null;
      newPosition = positionBetween(null, next);
    } else {
      const afterIndex = others.findIndex((c) => c.id === afterId);
      if (afterIndex === -1) throw badRequest('invalid_after_id', 'afterId not found');
      const prev = others[afterIndex]!.position;
      const next = others[afterIndex + 1]?.position ?? null;
      newPosition = positionBetween(prev, next);
    }

    const moved = await this.repos.boards.moveColumnGuarded(
      columnId, newPosition, mutationScope(scope.workspaceId, actorUserId, 'editor'),
    );
    assertWrite(moved, 'editor');
    return { position: newPosition };
  }

  async deleteColumn(
    scope: ProjectScope,
    actorUserId: string,
    columnId: string,
    moveToColumnId?: string | null,
  ): Promise<void> {
    const column = await this.repos.boards.findColumnByIdInScope(scope, columnId);
    if (!column) throw notFound('not_found', 'Column not found');

    const board = await this.repos.boards.findByIdInScope(scope, column.boardId);
    if (!board) throw notFound('not_found', 'Board not found');

    if (this.repos.cards) {
      const columnCards = await this.repos.cards.listByColumn(
        scope,
        columnId,
      );
      if (columnCards.length > 0) {
        if (!moveToColumnId) {
          throw badRequest(
            'destination_required',
            'Column has cards; specify ?moveTo=<columnId> to migrate them',
          );
        }

        const dest = await this.repos.boards.findColumnByIdInScope(scope, moveToColumnId);
        if (!dest || dest.boardId !== column.boardId) {
          throw badRequest('invalid_destination', 'Destination column not found on this board');
        }

      }
    }

    const deleted = await this.repos.boards.deleteColumnGuarded(
      columnId,
      moveToColumnId ?? null,
      mutationScope(scope.workspaceId, actorUserId, 'editor'),
    );
    assertWrite(deleted, 'editor');
  }

}

function mutationScope(
  workspaceId: string,
  actorUserId: string,
  minimumRole: BoardMutationScope['minimumRole'],
): BoardMutationScope {
  return { workspaceId, actorUserId, minimumRole };
}

function assertWrite(succeeded: boolean, minimumRole: BoardMutationScope['minimumRole']): void {
  if (!succeeded) {
    throw forbidden(
      'forbidden',
      minimumRole === 'owner' ? 'Workspace owner access changed' : 'Workspace editor access changed',
    );
  }
}

import { expect, it } from 'vitest';
import type { IBoardRepository, CreateBoardData, CreateColumnData } from '../../src/core/infrastructure/types';

type Query = (
  sql: string,
  params?: Array<string | number | null>,
) => Promise<Record<string, unknown>[]>;

interface Fixture {
  boards: Pick<IBoardRepository, 'createWithColumns'>;
  query: Query;
}

const editorScope = (workspaceId: string) => ({
  workspaceId,
  actorUserId: 'board-contract-user',
  minimumRole: 'editor' as const,
});

const newBoard = (workspaceId: string, projectId: string): CreateBoardData => {
  const now = Date.now();
  return {
    id: crypto.randomUUID(),
    workspaceId,
    projectId,
    name: 'Atomic board',
    icon: null,
    position: 'a0',
    createdAt: now,
    updatedAt: now,
  };
};

const newColumn = (boardId: string, id = crypto.randomUUID()): CreateColumnData => ({
  id,
  boardId,
  name: `Column ${id}`,
  color: null,
  position: 'a0',
  wipLimit: null,
});

async function ensureContractUser(query: Query) {
  try {
    await query(
      'INSERT INTO "user" (id, name, email, "emailVerified", "createdAt", "updatedAt") VALUES (?, ?, ?, ?, ?, ?)',
      ['board-contract-user', 'Board Contract User', 'board-contract@test.com', 0, 1, 1],
    );
  } catch {
    try {
      await query(
        "INSERT INTO \"user\" (id, name, email, email_verified, created_at, updated_at) VALUES ('board-contract-user', 'Board Contract User', 'board-contract@test.com', false, now(), now())",
      );
    } catch {
      /* ignore if user already exists */
    }
  }
}

/** Shared D1, Node/SQLite and PostgreSQL atomic starter-board contract. */
export function boardCreateAtomicCases(fixture: () => Fixture) {
  it('commits the board with every starter column', async () => {
    const { boards, query } = fixture();
    await ensureContractUser(query);
    const workspaceId = crypto.randomUUID();
    const projectId = crypto.randomUUID();
    const now = Date.now();
    await query(
      'INSERT INTO workspaces (id, name, created_by, created_at) VALUES (?, ?, ?, ?)',
      [workspaceId, 'Atomic board', 'board-contract-user', now],
    );
    await query(
      'INSERT INTO projects (id, workspace_id, name, position, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)',
      [projectId, workspaceId, 'Atomic board', 'a0', now, now],
    );
    await query('INSERT INTO members (workspace_id, user_id, role, joined_at) VALUES (?, ?, ?, ?)',
      [workspaceId, 'board-contract-user', 'owner', now]);

    const board = newBoard(workspaceId, projectId);
    const columns = [newColumn(board.id), newColumn(board.id), newColumn(board.id)];
    expect(await boards.createWithColumns(board, columns, editorScope(workspaceId))).toBe(true);

    expect(await query('SELECT id, workspace_id, project_id FROM boards WHERE id = ?', [board.id])).toEqual([
      { id: board.id, workspace_id: workspaceId, project_id: projectId },
    ]);
    expect(
      await query('SELECT id, board_id FROM board_columns WHERE board_id = ? ORDER BY id', [board.id]),
    ).toEqual(
      columns
        .map((column) => ({ id: column.id, board_id: board.id }))
        .sort((a, b) => a.id.localeCompare(b.id)),
    );
  });

  it('rolls back the board and earlier columns when a column insert fails', async () => {
    const { boards, query } = fixture();
    await ensureContractUser(query);
    const workspaceId = crypto.randomUUID();
    const projectId = crypto.randomUUID();
    const now = Date.now();
    await query(
      'INSERT INTO workspaces (id, name, created_by, created_at) VALUES (?, ?, ?, ?)',
      [workspaceId, 'Atomic board rollback', 'board-contract-user', now],
    );
    await query(
      'INSERT INTO projects (id, workspace_id, name, position, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)',
      [projectId, workspaceId, 'Atomic board rollback', 'a0', now, now],
    );
    await query('INSERT INTO members (workspace_id, user_id, role, joined_at) VALUES (?, ?, ?, ?)',
      [workspaceId, 'board-contract-user', 'owner', now]);

    const board = newBoard(workspaceId, projectId);
    const duplicateColumnId = crypto.randomUUID();
    const columns = [
      newColumn(board.id),
      newColumn(board.id, duplicateColumnId),
      newColumn(board.id, duplicateColumnId),
    ];
    await expect(boards.createWithColumns(board, columns, editorScope(workspaceId))).rejects.toThrow();

    expect(await query('SELECT id FROM boards WHERE id = ?', [board.id])).toEqual([]);
    expect(await query('SELECT id FROM board_columns WHERE board_id = ?', [board.id])).toEqual([]);
  });

  it('rejects a viewer or revoked actor before creating a board or starter columns', async () => {
    const { boards, query } = fixture();
    await ensureContractUser(query);
    const workspaceId = crypto.randomUUID();
    const projectId = crypto.randomUUID();
    const now = Date.now();
    await query('INSERT INTO workspaces (id, name, created_by, created_at) VALUES (?, ?, ?, ?)',
      [workspaceId, 'Denied board', 'board-contract-user', now]);
    await query('INSERT INTO projects (id, workspace_id, name, position, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)',
      [projectId, workspaceId, 'Denied board', 'a0', now, now]);
    await query('INSERT INTO members (workspace_id, user_id, role, joined_at) VALUES (?, ?, ?, ?)',
      [workspaceId, 'board-contract-user', 'viewer', now]);
    const board = newBoard(workspaceId, projectId);
    const columns = [newColumn(board.id)];

    expect(await boards.createWithColumns(board, columns, editorScope(workspaceId))).toBe(false);
    expect(await query('SELECT id FROM boards WHERE id = ?', [board.id])).toEqual([]);
    expect(await query('SELECT id FROM board_columns WHERE board_id = ?', [board.id])).toEqual([]);
  });
}

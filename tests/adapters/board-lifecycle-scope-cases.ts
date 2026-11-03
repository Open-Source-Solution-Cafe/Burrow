import { expect } from 'vitest';
import type { IBoardRepository } from '../../src/core/infrastructure/types';

type Query = (
  sql: string,
  params?: Array<string | number | null>,
) => Promise<Record<string, unknown>[]>;

export async function assertBoardLifecycleScope(
  boards: IBoardRepository,
  query: Query,
  dialect: 'sqlite' | 'postgres',
) {
  const id = () => crypto.randomUUID();
  const owner = id(),
    workspace = id(),
    foreignWorkspace = id();
  const project = id(),
    foreignProject = id();
  const now = Date.now();
  const userTimes = dialect === 'postgres' ? 'created_at, updated_at' : '"createdAt", "updatedAt"';
  const time = dialect === 'postgres' ? new Date(now).toISOString() : now;
  await query(`INSERT INTO "user" (id, name, email, ${userTimes}) VALUES (?, 'Owner', ?, ?, ?)`, [
    owner,
    `${owner}@board-lifecycle.test`,
    time,
    time,
  ]);
  for (const ws of [workspace, foreignWorkspace])
    await query('INSERT INTO workspaces (id, name, created_by, created_at) VALUES (?, ?, ?, ?)', [
      ws,
      'Workspace',
      owner,
      now,
    ]);
  await query('INSERT INTO members (workspace_id, user_id, role, joined_at) VALUES (?, ?, ?, ?)', [
    workspace, owner, 'owner', now,
  ]);
  for (const [proj, ws] of [
    [project, workspace],
    [foreignProject, foreignWorkspace],
  ])
    await query(
      "INSERT INTO projects (id, workspace_id, name, position, created_at, updated_at) VALUES (?, ?, 'Project', 'a0', ?, ?)",
      [proj!, ws!, now, now],
    );

  const setup = async (prefix: string, mode: 'soft' | 'restore' | 'hard') => {
    const boardId = id(),
      columnId = id(),
      foreignColumnId = id();
    const stamp = now + 100;
    const operationId = mode === 'restore' ? id() : null;
    await query(
      'INSERT INTO boards (id, workspace_id, project_id, name, position, created_at, updated_at, deleted_at, deletion_operation_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
      [boardId, workspace, project, prefix, 'a0', now, now, mode === 'restore' ? stamp : null, operationId],
    );
    await query(
      "INSERT INTO board_columns (id, board_id, name, position) VALUES (?, ?, 'Local', 'a0')",
      [columnId, boardId],
    );
    const otherBoard = id();
    await query(
      'INSERT INTO boards (id, workspace_id, project_id, name, position, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
      [otherBoard, workspace, project, 'Other', 'a1', now, now],
    );
    await query(
      "INSERT INTO board_columns (id, board_id, name, position) VALUES (?, ?, 'Foreign', 'a0')",
      [foreignColumnId, otherBoard],
    );
    const note = async (
      notepadId: string,
      ws: string,
      proj: string,
      kind: string,
      deletedAt: number | null,
      deletionOperationId?: string | null,
    ) => {
      await query(
        'INSERT INTO notepads (id, workspace_id, project_id, kind, title, position, created_by, deleted_at, deletion_operation_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
        [notepadId, ws, proj, kind, `${prefix} ${notepadId}`, 'a0', owner, deletedAt, deletionOperationId ?? null, now, now],
      );
    };
    const valid = id();
    await note(valid, workspace, project, 'card', mode === 'restore' ? stamp : null, operationId);
    await query(
      "INSERT INTO cards (id, board_id, column_id, notepad_id, position, created_at) VALUES (?, ?, ?, ?, 'a0', ?)",
      [id(), boardId, columnId, valid, now],
    );
    const unrelated = id();
    await note(unrelated, foreignWorkspace, foreignProject, 'notepad', null);
    return { boardId, valid, unrelated, stamp };
  };
  const deletedColumn = dialect === 'postgres' ? 'deleted_at' : 'deleted_at AS deletedAt';
  const value = async (notepadId: string) =>
    Number(
      (await query(`SELECT ${deletedColumn} FROM notepads WHERE id = ?`, [notepadId]))[0]?.[
        dialect === 'postgres' ? 'deleted_at' : 'deletedAt'
      ],
    ) || null;

  const soft = await setup('soft', 'soft');
  const editorScope = { workspaceId: workspace, actorUserId: owner, minimumRole: 'editor' as const };
  const ownerScope = { ...editorScope, minimumRole: 'owner' as const };
  expect(await boards.softDeleteGuarded(soft.boardId, soft.stamp, editorScope)).toBe(true);
  expect(await value(soft.valid)).toBe(soft.stamp);
  expect(await value(soft.unrelated)).toBeNull();

  const restore = await setup('restore', 'restore');
  expect(await boards.restoreGuarded(restore.boardId, editorScope)).toBe(true);
  expect(await value(restore.valid)).toBeNull();
  expect(await value(restore.unrelated)).toBeNull();

  const hard = await setup('hard', 'hard');
  await boards.softDeleteGuarded(hard.boardId, hard.stamp, editorScope);
  expect(await boards.hardDeleteGuarded(hard.boardId, ownerScope)).toBe(true);
  expect(await query('SELECT id FROM notepads WHERE id = ?', [hard.valid])).toHaveLength(0);
  expect(await query('SELECT id FROM notepads WHERE id = ?', [hard.unrelated])).toHaveLength(1);
}

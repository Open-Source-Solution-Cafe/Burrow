import { expect } from 'vitest';
import type { IBoardRepository } from '../../src/core/infrastructure/types';

type Query = (
  sql: string,
  params?: Array<string | number | null>,
) => Promise<Record<string, unknown>[]>;

export async function assertBoardSourceScope(
  boards: IBoardRepository,
  query: Query,
  dialect: 'sqlite' | 'postgres',
) {
  const workspace = crypto.randomUUID();
  const otherWorkspace = crypto.randomUUID();
  const project = crypto.randomUUID();
  const otherProject = crypto.randomUUID();
  const user = crypto.randomUUID();
  const now = Date.now();
  const userTimes = dialect === 'postgres' ? 'created_at, updated_at' : '"createdAt", "updatedAt"';
  const time = dialect === 'postgres' ? new Date(now).toISOString() : now;
  await query(`INSERT INTO "user" (id, name, email, ${userTimes}) VALUES (?, 'Owner', ?, ?, ?)`, [
    user,
    `${user}@scope.test`,
    time,
    time,
  ]);
  for (const id of [workspace, otherWorkspace]) {
    await query('INSERT INTO workspaces (id, name, created_by, created_at) VALUES (?, ?, ?, ?)', [
      id,
      'Workspace',
      user,
      now,
    ]);
  }
  for (const [id, ws] of [
    [project, workspace],
    [otherProject, otherWorkspace],
  ]) {
    await query(
      "INSERT INTO projects (id, workspace_id, name, position, created_at, updated_at) VALUES (?, ?, 'Project', 'a0', ?, ?)",
      [id!, ws!, now, now],
    );
  }
  const first = crypto.randomUUID();
  const second = crypto.randomUUID();
  const corrupt = crypto.randomUUID();
  const deleted = crypto.randomUUID();
  const deletedEarlier = crypto.randomUUID();
  const localColumn = crypto.randomUUID();
  const foreignBoard = crypto.randomUUID();
  const foreignColumn = crypto.randomUUID();
  const deletedColumn = crypto.randomUUID();
  const board = async (
    id: string,
    ws: string,
    proj: string,
    position: string,
    deletedAt: number | null = null,
  ) => {
    await query(
      'INSERT INTO boards (id, workspace_id, project_id, name, position, created_at, updated_at, deleted_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      [id, ws, proj, id, position, now, now, deletedAt],
    );
  };
  await board(second, workspace, project, 'a1');
  await board(first, workspace, project, 'a0');
  await expect(board(corrupt, otherWorkspace, project, 'a2')).rejects.toThrow(
    'scope_write_conflict',
  );
  await board(deleted, workspace, project, 'a3', now + 1);
  await board(deletedEarlier, workspace, project, 'a4', now);
  await board(foreignBoard, otherWorkspace, otherProject, 'a0');
  for (const [id, boardId] of [
    [localColumn, first],
    [foreignColumn, foreignBoard],
    [deletedColumn, deleted],
  ]) {
    await query(
      "INSERT INTO board_columns (id, board_id, name, position) VALUES (?, ?, 'Column', 'a0')",
      [id!, boardId!],
    );
  }
  expect((await boards.listByProject({ workspaceId: workspace, projectId: project })).map((row) => row.id)).toEqual([first, second]);
  expect((await boards.listDeletedByProject({ workspaceId: workspace, projectId: project })).map((row) => row.id)).toEqual([
    deleted,
    deletedEarlier,
  ]);
  const scope = { workspaceId: workspace, projectId: project };
  const foreignScope = { workspaceId: otherWorkspace, projectId: otherProject };
  expect((await boards.findByIdInScope(scope, first))?.id).toBe(first);
  expect((await boards.findByIdInScope(scope, deleted))?.id).toBe(deleted);
  expect(await boards.findByIdInScope(foreignScope, first)).toBeNull();
  expect(await boards.findByIdInScope(scope, corrupt)).toBeNull();
  expect(await boards.findByIdInScope(foreignScope, corrupt)).toBeNull();
  expect((await boards.findColumnByIdInScope(scope, localColumn))?.id).toBe(localColumn);
  expect(await boards.findColumnByIdInScope(foreignScope, localColumn)).toBeNull();
  expect((await boards.findColumnByIdInScope(foreignScope, foreignColumn))?.id).toBe(foreignColumn);
  expect(await boards.findColumnByIdInScope(scope, foreignColumn)).toBeNull();
  expect(await boards.findColumnByIdInScope(scope, deletedColumn)).toBeNull();
  expect((await boards.listByProject({ workspaceId: otherWorkspace, projectId: otherProject })).map((row) => row.id)).toEqual([foreignBoard]);
}

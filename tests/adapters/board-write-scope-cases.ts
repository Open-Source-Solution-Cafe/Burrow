import { expect, it } from 'vitest';
import type { IBoardRepository, BoardMutationScope } from '../../src/core/infrastructure/types';

type Query = (sql: string, params?: Array<string | number | null>) => Promise<Record<string, unknown>[]>;

interface Fixture {
  boards: IBoardRepository;
  query: Query;
}

const id = () => crypto.randomUUID();

async function setup(fixture: Fixture) {
  const { boards, query } = fixture;
  const workspaceId = id();
  const projectId = id();
  const ownerId = 'board-scope-owner';
  const editorId = 'board-scope-editor';
  const viewerId = 'board-scope-viewer';
  const now = Date.now();
  await query('INSERT INTO workspaces (id, name, created_by, created_at) VALUES (?, ?, ?, ?)',
    [workspaceId, 'Board write scope', ownerId, now]);
  await query('INSERT INTO projects (id, workspace_id, name, position, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)',
    [projectId, workspaceId, 'Board write scope', 'a0', now, now]);
  for (const [userId, role] of [[ownerId, 'owner'], [editorId, 'editor'], [viewerId, 'viewer']] as const) {
    await query('INSERT INTO members (workspace_id, user_id, role, joined_at) VALUES (?, ?, ?, ?)',
      [workspaceId, userId, role, now]);
  }
  const boardId = id();
  const sourceColumnId = id();
  const targetColumnId = id();
  const board = {
    id: boardId,
    workspaceId,
    projectId,
    name: 'Board',
    icon: null,
    position: 'a0',
    createdAt: now,
    updatedAt: now,
  };
  expect(await boards.createWithColumns(board, [
    { id: sourceColumnId, boardId, name: 'Source', color: null, position: 'a0', wipLimit: null },
    { id: targetColumnId, boardId, name: 'Target', color: null, position: 'a1', wipLimit: null },
  ], { workspaceId, actorUserId: ownerId, minimumRole: 'editor' })).toBe(true);
  return {
    workspaceId, projectId, ownerId, editorId, viewerId, boardId, sourceColumnId, targetColumnId,
    scope(actorUserId: string, minimumRole: BoardMutationScope['minimumRole'] = 'editor'): BoardMutationScope {
      return { workspaceId, actorUserId, minimumRole };
    },
  };
}

/** Shared D1, Node/SQLite, and PostgreSQL board mutation authorization contract. */
export function boardWriteScopeCases(fixture: () => Fixture) {
  it('rechecks membership and role when updating boards and creating columns', async () => {
    const current = fixture();
    const { boards, query } = current;
    const data = await setup(current);

    expect(await boards.updateGuarded(data.boardId, { name: 'Denied', updatedAt: Date.now() }, data.scope(data.viewerId))).toBe(false);
    expect(await boards.createColumnGuarded({
      id: id(), boardId: data.boardId, name: 'Denied', color: null, position: 'a2', wipLimit: null,
    }, data.scope(data.viewerId))).toBe(false);
    expect(await boards.updateColumnGuarded(data.sourceColumnId, { name: 'Denied' }, data.scope(data.viewerId))).toBe(false);
    expect(await boards.moveColumnGuarded(data.sourceColumnId, 'z0', data.scope(data.viewerId))).toBe(false);
    expect(await boards.softDeleteGuarded(data.boardId, Date.now(), data.scope(data.viewerId))).toBe(false);
    expect(await boards.updateGuarded(data.boardId, { name: 'Revoked', updatedAt: Date.now() }, data.scope(data.editorId))).toBe(true);

    await query('UPDATE members SET role = ? WHERE workspace_id = ? AND user_id = ?',
      ['viewer', data.workspaceId, data.editorId]);
    expect(await boards.updateGuarded(data.boardId, { name: 'Denied after revoke', updatedAt: Date.now() }, data.scope(data.editorId))).toBe(false);
    expect(await query('SELECT name FROM boards WHERE id = ?', [data.boardId])).toEqual([{ name: 'Revoked' }]);

    await query('UPDATE members SET role = ? WHERE workspace_id = ? AND user_id = ?',
      ['editor', data.workspaceId, data.editorId]);
    expect(await boards.softDeleteGuarded(data.boardId, Date.now(), data.scope(data.editorId))).toBe(true);
    expect(await boards.hardDeleteGuarded(data.boardId, data.scope(data.editorId, 'owner'))).toBe(false);
    expect(await query('SELECT id FROM boards WHERE id = ?', [data.boardId])).toHaveLength(1);
  });

  it('moves cards and deletes their source column atomically after rechecking editor role', async () => {
    const current = fixture();
    const { boards, query } = current;
    const data = await setup(current);
    const noteId = id();
    const cardId = id();
    const now = Date.now();
    await query(`INSERT INTO notepads (id, workspace_id, project_id, kind, title, content, version, position, is_favorite, created_by, created_at, updated_at)
      VALUES (?, ?, ?, 'card', 'Body', '[]', 1, 'a0', false, ?, ?, ?)`,
      [noteId, data.workspaceId, data.projectId, data.ownerId, now, now]);
    await query('INSERT INTO cards (id, board_id, column_id, notepad_id, position, created_at) VALUES (?, ?, ?, ?, ?, ?)',
      [cardId, data.boardId, data.sourceColumnId, noteId, 'a0', now]);

    await query('UPDATE members SET role = ? WHERE workspace_id = ? AND user_id = ?',
      ['viewer', data.workspaceId, data.editorId]);
    expect(await boards.deleteColumnGuarded(data.sourceColumnId, data.targetColumnId, data.scope(data.editorId))).toBe(false);
    expect(await query('SELECT column_id FROM cards WHERE id = ?', [cardId])).toEqual([{ column_id: data.sourceColumnId }]);

    await query('UPDATE members SET role = ? WHERE workspace_id = ? AND user_id = ?',
      ['editor', data.workspaceId, data.editorId]);
    expect(await boards.deleteColumnGuarded(data.sourceColumnId, data.targetColumnId, data.scope(data.editorId))).toBe(true);
    expect(await query('SELECT column_id FROM cards WHERE id = ?', [cardId])).toEqual([{ column_id: data.targetColumnId }]);
    expect(await query('SELECT id FROM board_columns WHERE id = ?', [data.sourceColumnId])).toEqual([]);
  });
}

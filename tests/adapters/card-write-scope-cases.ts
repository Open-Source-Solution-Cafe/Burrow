import { expect, it } from 'vitest';
import type { ICardRepository } from '../../src/core/infrastructure/types';

type Query = (sql: string, params?: Array<string | number | null>) => Promise<Record<string, unknown>[]>;

export function cardWriteScopeCases(fixture: () => { cards: ICardRepository; query: Query }, dialect: 'sqlite' | 'postgres') {
  it('rejects an editor demoted before the update and preserves card metadata', async () => {
    const { cards, query } = fixture();
    const id = () => crypto.randomUUID();
    const workspaceId = id(), projectId = id(), userId = id(), boardId = id(), columnId = id();
    const notepadId = id(), cardId = id(), now = Date.now();
    const isSqlite = dialect === 'sqlite';
    const createdAt = isSqlite ? now : new Date(now).toISOString();
    const userTimes = isSqlite ? '"createdAt", "updatedAt"' : 'created_at, updated_at';
    await query(`INSERT INTO "user" (id, name, email, ${userTimes}) VALUES (?, 'Editor', ?, ?, ?)`,
      [userId, `${userId}@card-write.test`, createdAt, createdAt]);
    await query('INSERT INTO workspaces (id, name, created_by, created_at) VALUES (?, ?, ?, ?)',
      [workspaceId, 'Card writes', userId, now]);
    await query("INSERT INTO members (workspace_id, user_id, role, joined_at) VALUES (?, ?, 'editor', ?)",
      [workspaceId, userId, now]);
    await query("INSERT INTO projects (id, workspace_id, name, position, created_at, updated_at) VALUES (?, ?, 'Project', 'a0', ?, ?)",
      [projectId, workspaceId, now, now]);
    await query("INSERT INTO boards (id, workspace_id, project_id, name, position, created_at, updated_at) VALUES (?, ?, ?, 'Board', 'a0', ?, ?)",
      [boardId, workspaceId, projectId, now, now]);
    await query("INSERT INTO board_columns (id, board_id, name, position) VALUES (?, ?, 'Todo', 'a0')", [columnId, boardId]);
    await query("INSERT INTO notepads (id, workspace_id, project_id, kind, title, content, version, position, is_favorite, created_by, created_at, updated_at) VALUES (?, ?, ?, 'card', 'Card', '[]', 1, 'a0', 0, ?, ?, ?)",
      [notepadId, workspaceId, projectId, userId, now, now]);
    await query('INSERT INTO cards (id, board_id, column_id, notepad_id, position, priority, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
      [cardId, boardId, columnId, notepadId, 'a0', null, now]);
    await query('UPDATE members SET role = ? WHERE workspace_id = ? AND user_id = ?', ['viewer', workspaceId, userId]);
    expect(await cards.updateGuarded({
      cardId, scope: { workspaceId, actorUserId: userId, minimumRole: 'editor' },
      data: { priority: 'high' }, now,
    })).toBe(false);
    expect(await query('SELECT priority FROM cards WHERE id = ?', [cardId])).toEqual([{ priority: null }]);
  });
}

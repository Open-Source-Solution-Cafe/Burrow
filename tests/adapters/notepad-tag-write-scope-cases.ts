import { expect, it } from 'vitest';
import type { INotepadRepository, ITagRepository } from '../../src/core/infrastructure/types';

type Query = (sql: string, params?: Array<string | number | null>) => Promise<Record<string, unknown>[]>;

export function notepadWriteScopeCases(
  fixture: () => { notepads: INotepadRepository; query: Query },
  dialect: 'sqlite' | 'postgres',
) {
  it('rejects note lifecycle writes after editor demotion and preserves the subtree', async () => {
    const { notepads, query } = fixture();
    const workspaceId = crypto.randomUUID(), projectId = crypto.randomUUID(), actorUserId = crypto.randomUUID();
    const root = crypto.randomUUID(), child = crypto.randomUUID(), now = Date.now();
    const timestamp = dialect === 'sqlite' ? now : new Date(now).toISOString();
    const userTimes = dialect === 'sqlite' ? '"createdAt", "updatedAt"' : 'created_at, updated_at';
    await query(`INSERT INTO "user" (id, name, email, ${userTimes}) VALUES (?, 'Actor', ?, ?, ?)`, [actorUserId, `${actorUserId}@note-write.test`, timestamp, timestamp]);
    await query('INSERT INTO workspaces (id, name, created_by, created_at) VALUES (?, ?, ?, ?)', [workspaceId, 'Note write scope', actorUserId, now]);
    await query("INSERT INTO members (workspace_id, user_id, role, joined_at) VALUES (?, ?, 'editor', ?)", [workspaceId, actorUserId, now]);
    await query("INSERT INTO projects (id, workspace_id, name, position, created_at, updated_at) VALUES (?, ?, 'Project', 'a0', ?, ?)", [projectId, workspaceId, now, now]);
    const insertNote = async (id: string, parent: string | null, position: string) => query(
      "INSERT INTO notepads (id, workspace_id, project_id, parent_id, kind, title, content, version, position, created_by, created_at, updated_at) VALUES (?, ?, ?, ?, 'notepad', 'Original', '[]', 1, ?, ?, ?, ?)",
      [id, workspaceId, projectId, parent, position, actorUserId, now, now],
    );
    await insertNote(root, null, 'a0');
    await insertNote(child, root, 'a0');
    const scope = { workspaceId, projectId, actorUserId, minimumRole: 'editor' as const };
    await query('UPDATE members SET role = ? WHERE workspace_id = ? AND user_id = ?', ['viewer', workspaceId, actorUserId]);
    expect(await notepads.update(root, { title: 'Changed', updatedAt: now + 1 }, scope)).toBe(false);
    expect(await notepads.softDelete(root, now + 1, scope)).toBe(false);
    expect(await notepads.move(root, null, 'b0', scope)).toBe(false);
    expect(await notepads.setTagIds(root, [], scope)).toBe(false);
    await expect(notepads.saveContentBatch({
      row: { id: root, workspaceId, projectId, title: 'Original' }, scope, content: '[{"type":"paragraph"}]',
      baseVersion: 1, actorId: actorUserId, validLinks: [], previousLinks: [], now: now + 2,
    })).rejects.toThrow('workspace_write_forbidden');
    const deletionAt = now + 3;
    await query('UPDATE notepads SET deleted_at = ? WHERE id IN (?, ?)', [deletionAt, root, child]);
    expect(await notepads.restore(root, deletionAt, scope)).toBeNull();
    expect(await notepads.hardDelete(root, { ...scope, minimumRole: 'owner' })).toBeNull();
    expect(await query('SELECT id FROM notepads WHERE id IN (?, ?) ORDER BY id', [root, child])).toHaveLength(2);
    expect(await query('SELECT id, title, deleted_at FROM notepads WHERE id IN (?, ?) ORDER BY id', [root, child]))
      .toEqual(expect.arrayContaining([{ id: root, title: 'Original', deleted_at: deletionAt }, { id: child, title: 'Original', deleted_at: deletionAt }]));
  });
}

export function tagWriteScopeCases(
  fixture: () => { tags: ITagRepository; query: Query },
  dialect: 'sqlite' | 'postgres',
) {
  it('rejects tag create, update, and delete after editor demotion', async () => {
    const { tags, query } = fixture();
    const workspaceId = crypto.randomUUID(), projectId = crypto.randomUUID(), actorUserId = crypto.randomUUID();
    const tagId = crypto.randomUUID(), now = Date.now();
    const timestamp = dialect === 'sqlite' ? now : new Date(now).toISOString();
    const userTimes = dialect === 'sqlite' ? '"createdAt", "updatedAt"' : 'created_at, updated_at';
    await query(`INSERT INTO "user" (id, name, email, ${userTimes}) VALUES (?, 'Actor', ?, ?, ?)`, [actorUserId, `${actorUserId}@tag-write.test`, timestamp, timestamp]);
    await query('INSERT INTO workspaces (id, name, created_by, created_at) VALUES (?, ?, ?, ?)', [workspaceId, 'Tag write scope', actorUserId, now]);
    await query("INSERT INTO members (workspace_id, user_id, role, joined_at) VALUES (?, ?, 'editor', ?)", [workspaceId, actorUserId, now]);
    await query("INSERT INTO projects (id, workspace_id, name, position, created_at, updated_at) VALUES (?, ?, 'Project', 'a0', ?, ?)", [projectId, workspaceId, now, now]);
    await query('INSERT INTO tags (id, project_id, name, color) VALUES (?, ?, ?, ?)', [tagId, projectId, 'Original', null]);
    const scope = { workspaceId, projectId, actorUserId, minimumRole: 'editor' as const };
    await query('UPDATE members SET role = ? WHERE workspace_id = ? AND user_id = ?', ['viewer', workspaceId, actorUserId]);
    expect(await tags.createGuarded({ id: crypto.randomUUID(), projectId, name: 'New', color: null }, scope)).toBeNull();
    expect(await tags.updateGuarded(tagId, { name: 'Changed' }, scope)).toBe(false);
    expect(await tags.deleteGuarded(tagId, scope)).toBe(false);
    expect(await query('SELECT name FROM tags WHERE id = ?', [tagId])).toEqual([{ name: 'Original' }]);
    expect(await query('SELECT COUNT(*) AS n FROM tags WHERE project_id = ?', [projectId])).toEqual([{ n: 1 }]);
  });
}

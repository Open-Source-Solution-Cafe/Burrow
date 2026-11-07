import { expect } from 'vitest';
import type { INotepadRepository } from '../../src/core/infrastructure/types';

type Query = (
  sql: string,
  params?: Array<string | number | null>,
) => Promise<Record<string, unknown>[]>;

/** Shared repository lifecycle contract for D1, Node/SQLite and PostgreSQL. */
export async function assertNotepadLifecycle(
  notepads: INotepadRepository,
  query: Query,
) {
  const id = () => crypto.randomUUID();
  const owner = id();
  const workspaceId = id();
  const otherWorkspaceId = id();
  const projectId = id();
  const otherProjectId = id();
  const foreignProjectId = id();
  const now = Date.now();

  try {
    await query(
      'INSERT INTO "user" (id, name, email, "emailVerified", "createdAt", "updatedAt") VALUES (?, ?, ?, ?, ?, ?)',
      [owner, 'Test User', `${owner}@test.com`, 0, now, now],
    );
  } catch {
    try {
      await query(
        `INSERT INTO "user" (id, name, email, email_verified, created_at, updated_at) VALUES ('${owner}', 'Test User', '${owner}@test.com', false, now(), now())`,
      );
    } catch {}
  }

  for (const workspace of [workspaceId, otherWorkspaceId]) {
    await query(
      'INSERT INTO workspaces (id, name, created_by, created_at) VALUES (?, ?, ?, ?)',
      [workspace, 'Notepad lifecycle', owner, now],
    );
  }
  await query(
    "INSERT INTO members (workspace_id, user_id, role, joined_at) VALUES (?, ?, 'owner', ?)",
    [workspaceId, owner, now],
  );
  for (const [project, workspace] of [
    [projectId, workspaceId],
    [otherProjectId, workspaceId],
    [foreignProjectId, otherWorkspaceId],
  ]) {
    await query(
      'INSERT INTO projects (id, workspace_id, name, position, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)',
      [project!, workspace!, 'Notepad lifecycle', 'a0', now, now],
    );
  }

  const note = async (args: {
    noteId: string;
    workspace: string;
    project: string;
    parent?: string | null;
    deletedAt?: number | null;
  }) => {
    await query(
      'INSERT INTO notepads (id, workspace_id, project_id, parent_id, title, position, created_by, created_at, updated_at, deleted_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      [
        args.noteId,
        args.workspace,
        args.project,
        args.parent ?? null,
        `Note ${args.noteId}`,
        'a0',
        owner,
        now,
        now,
        args.deletedAt ?? null,
      ],
    );
  };

  const withLegacyParentEdge = async <T>(insert: () => Promise<T>): Promise<T> => {
    let isSqlite = true;
    try {
      await query('DROP TRIGGER IF EXISTS notepads_scope_insert_guard');
    } catch {
      isSqlite = false;
      await query('DROP TRIGGER IF EXISTS notepads_scope_write_guard ON notepads');
    }
    try {
      return await insert();
    } finally {
      if (isSqlite) {
        await query(`CREATE TRIGGER notepads_scope_insert_guard
          BEFORE INSERT ON notepads
          WHEN NOT EXISTS (
            SELECT 1 FROM projects p
            WHERE p.id = NEW.project_id AND p.workspace_id = NEW.workspace_id
          ) OR (NEW.parent_id IS NOT NULL AND NOT EXISTS (
            SELECT 1 FROM notepads parent
            WHERE parent.id = NEW.parent_id
              AND parent.project_id = NEW.project_id
              AND parent.workspace_id = NEW.workspace_id
          )) OR (NEW.kind = 'card' AND NEW.parent_id IS NOT NULL)
          BEGIN SELECT RAISE(ABORT, 'scope_write_conflict'); END`);
      } else {
        await query(`CREATE TRIGGER notepads_scope_write_guard
          BEFORE INSERT OR UPDATE OF project_id, workspace_id, parent_id, kind ON notepads
          FOR EACH ROW EXECUTE FUNCTION enforce_scope_write()`);
      }
    }
  };

  const deletedAt = async (noteId: string): Promise<number | null> => {
    const rows = await query('SELECT deleted_at FROM notepads WHERE id = ?', [noteId]);
    return rows[0]?.deleted_at === null || rows[0]?.deleted_at === undefined
      ? null
      : Number(rows[0].deleted_at);
  };

  const rootId = id();
  const liveChildId = id();
  const preDeletedChildId = id();
  const unrelatedRootId = id();
  const otherProjectRootId = id();
  const foreignWorkspaceRootId = id();
  const priorDeleteAt = now - 60_000;
  await note({ noteId: rootId, workspace: workspaceId, project: projectId });
  await note({
    noteId: liveChildId,
    workspace: workspaceId,
    project: projectId,
    parent: rootId,
  });
  await note({
    noteId: preDeletedChildId,
    workspace: workspaceId,
    project: projectId,
    parent: liveChildId,
    deletedAt: priorDeleteAt,
  });
  await note({ noteId: unrelatedRootId, workspace: workspaceId, project: projectId });
  const rejectedOtherProjectChildId = id();
  const rejectedForeignWorkspaceChildId = id();
  await expect(
    note({
      noteId: rejectedOtherProjectChildId,
      workspace: workspaceId,
      project: otherProjectId,
      parent: rootId,
    }),
  ).rejects.toThrow('scope_write_conflict');
  await expect(
    note({
      noteId: rejectedForeignWorkspaceChildId,
      workspace: otherWorkspaceId,
      project: foreignProjectId,
      parent: rootId,
    }),
  ).rejects.toThrow('scope_write_conflict');
  await note({
    noteId: otherProjectRootId,
    workspace: workspaceId,
    project: otherProjectId,
  });
  await note({
    noteId: foreignWorkspaceRootId,
    workspace: otherWorkspaceId,
    project: foreignProjectId,
  });

  const operationAt = now + 10_000;
  const scope = { workspaceId, projectId, actorUserId: owner, minimumRole: 'owner' as const };
  await notepads.softDelete(rootId, operationAt, scope);

  expect(await deletedAt(rootId)).toBe(operationAt);
  expect(await deletedAt(liveChildId)).toBe(operationAt);
  expect(await deletedAt(preDeletedChildId)).toBe(priorDeleteAt);
  expect(await deletedAt(unrelatedRootId)).toBeNull();
  expect(await deletedAt(otherProjectRootId)).toBeNull();
  expect(await deletedAt(foreignWorkspaceRootId)).toBeNull();

  const hardRootId = id();
  const hardChildId = id();
  const hardGrandchildId = id();
  const hardUnrelatedRootId = id();
  const hardOtherProjectChildId = id();
  await note({
    noteId: hardRootId,
    workspace: workspaceId,
    project: projectId,
    deletedAt: operationAt,
  });
  await note({
    noteId: hardChildId,
    workspace: workspaceId,
    project: projectId,
    parent: hardRootId,
    deletedAt: operationAt,
  });
  await note({
    noteId: hardGrandchildId,
    workspace: workspaceId,
    project: projectId,
    parent: hardChildId,
  });
  await note({ noteId: hardUnrelatedRootId, workspace: workspaceId, project: projectId });
  await withLegacyParentEdge(() =>
    note({
      noteId: hardOtherProjectChildId,
      workspace: workspaceId,
      project: otherProjectId,
      parent: hardRootId,
    }),
  );

  await expect(notepads.hardDelete(hardRootId, scope)).rejects.toThrow('tree_scope_conflict');
  for (const preservedId of [hardRootId, hardChildId, hardGrandchildId, hardOtherProjectChildId]) {
    expect(await query('SELECT id FROM notepads WHERE id = ?', [preservedId])).toHaveLength(1);
  }
  await query('DELETE FROM notepads WHERE id = ?', [hardOtherProjectChildId]);

  const validHardRootId = id();
  const validHardChildId = id();
  const validHardGrandchildId = id();
  await note({
    noteId: validHardRootId,
    workspace: workspaceId,
    project: projectId,
    deletedAt: operationAt,
  });
  await note({
    noteId: validHardChildId,
    workspace: workspaceId,
    project: projectId,
    parent: validHardRootId,
    deletedAt: operationAt,
  });
  await note({
    noteId: validHardGrandchildId,
    workspace: workspaceId,
    project: projectId,
    parent: validHardChildId,
  });

  await notepads.hardDelete(validHardRootId, scope);

  for (const removedId of [validHardRootId, validHardChildId, validHardGrandchildId]) {
    expect(await query('SELECT id FROM notepads WHERE id = ?', [removedId])).toHaveLength(0);
  }
  for (const survivingId of [hardUnrelatedRootId, hardRootId]) {
    expect(await query('SELECT id FROM notepads WHERE id = ?', [survivingId])).toHaveLength(1);
  }
}

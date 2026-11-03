import { expect } from 'vitest';
import type { INotepadRepository } from '../../src/core/infrastructure/types';
import { getDepth, getDescendantIds } from '../../src/core/shared/tree';

/** Tree traversal stays within valid workspace/project records and ignores deleted rows. */
export async function assertTreeScopeIsolation(db: {
  notepads: Pick<INotepadRepository, 'getChildren' | 'getParent'>;
  query(text: string, params?: Array<string | number | null>): Promise<unknown>;
}) {
  const uid = () => crypto.randomUUID();
  const workspaceId = uid(),
    otherWorkspace = uid();
  const projectId = uid(),
    otherProject = uid(),
    foreignProject = uid();
  const rootId = uid(),
    foreignRoot = uid(),
    foreignWorkspaceRoot = uid(),
    liveId = uid(),
    deletedId = uid();
  const scope = { workspaceId, projectId };
  const now = Date.now();
  for (const id of [workspaceId, otherWorkspace]) {
    await db.query(
      'INSERT INTO workspaces (id, name, created_by, created_at) VALUES (?, ?, ?, ?)',
      [id, 'Tree scope', 'fixture-user', now],
    );
  }
  for (const [id, workspace] of [
    [projectId, workspaceId],
    [otherProject, workspaceId],
    [foreignProject, otherWorkspace],
  ]) {
    await db.query(
      'INSERT INTO projects (id, workspace_id, name, position, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)',
      [id!, workspace!, 'Tree scope', 'a0', now, now],
    );
  }
  const notes: Array<[string, string, string, string | null, number | null]> = [
    [rootId, workspaceId, projectId, null, null],
    [foreignRoot, workspaceId, otherProject, null, null],
    [foreignWorkspaceRoot, otherWorkspace, foreignProject, null, null],
    [liveId, workspaceId, projectId, rootId, null],
    [deletedId, workspaceId, projectId, rootId, now],
  ];
  for (const [id, workspace, project, parentId, deletedAt] of notes) {
    await db.query(
      'INSERT INTO notepads (id, workspace_id, project_id, parent_id, title, position, created_by, created_at, updated_at, deleted_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      [id, workspace, project, parentId, 'Tree note', 'a0', 'fixture-user', now, now, deletedAt],
    );
  }
  expect(await db.notepads.getChildren(scope, [rootId])).toEqual([
    { id: liveId, parentId: rootId },
  ]);
  expect(await db.notepads.getChildren(scope, [])).toEqual([]);
  expect(await db.notepads.getChildren(scope, [foreignRoot])).toEqual([]);
  expect(await db.notepads.getChildren(scope, [foreignWorkspaceRoot])).toEqual([]);
  expect(
    await db.notepads.getChildren({ workspaceId: otherWorkspace, projectId }, [rootId]),
  ).toEqual([]);
  expect(await db.notepads.getParent(scope, rootId)).toEqual({ id: rootId, parentId: null });
  expect(await db.notepads.getParent(scope, deletedId)).toEqual({
    id: deletedId,
    parentId: rootId,
  });
  expect(await db.notepads.getParent(scope, foreignRoot)).toBeNull();
  expect(await db.notepads.getParent(scope, foreignWorkspaceRoot)).toBeNull();
  expect(await db.notepads.getParent(scope, 'missing')).toBeNull();
  expect(
    await db.notepads.getParent({ workspaceId: otherWorkspace, projectId }, liveId),
  ).toBeNull();
  expect(await getDescendantIds((ids) => db.notepads.getChildren(scope, ids), rootId)).toEqual([
    liveId,
  ]);

  await db.query('UPDATE notepads SET parent_id = ? WHERE id = ?', [liveId, rootId]);
  try {
    await expect(
      getDescendantIds((ids) => db.notepads.getChildren(scope, ids), rootId),
    ).rejects.toThrow('tree_cycle_detected');
    await expect(getDepth((id) => db.notepads.getParent(scope, id), rootId)).rejects.toThrow(
      'tree_cycle_detected',
    );
  } finally {
    await db.query('UPDATE notepads SET parent_id = NULL WHERE id = ?', [rootId]);
  }
  return { scope, rootId, liveId, deletedId };
}

import { and, eq, inArray, isNull } from 'drizzle-orm';
import type { DB } from '../client';
import * as t from '../schema';
import type { ProjectScope } from '../../../../infrastructure/types';
import { chunkInList } from '../../../../services/utils/chunk';
import { getDescendantIds as descendants, type TreeNode } from '../../../../shared/tree';

/** Scope both child rows and requested parents; lifecycle traversal may include trash. */
export async function getNotepadChildren(
  db: DB,
  scope: ProjectScope,
  parentIds: string[],
  visibility: 'live' | 'all',
): Promise<TreeNode[]> {
  const children: TreeNode[] = [];
  for (const chunk of chunkInList(parentIds, 4)) {
    children.push(
      ...(await db
        .select({ id: t.notepads.id, parentId: t.notepads.parentId })
        .from(t.notepads)
        .where(
          and(
            eq(t.notepads.workspaceId, scope.workspaceId),
            eq(t.notepads.projectId, scope.projectId),
            visibility === 'live' ? isNull(t.notepads.deletedAt) : undefined,
            inArray(
              t.notepads.parentId,
              db
                .select({ id: t.notepads.id })
                .from(t.notepads)
                .where(
                  and(
                    eq(t.notepads.workspaceId, scope.workspaceId),
                    eq(t.notepads.projectId, scope.projectId),
                    inArray(t.notepads.id, chunk),
                  ),
                ),
            ),
          ),
        )),
    );
  }
  return children;
}

/** Lifecycle descendants include trash, but never leave the root's project/workspace. */
export async function getDescendantIds(db: DB, rootId: string): Promise<string[]> {
  const [scope] = await db
    .select({ workspaceId: t.notepads.workspaceId, projectId: t.notepads.projectId })
    .from(t.notepads)
    .where(eq(t.notepads.id, rootId));
  return scope ? descendants((ids) => getNotepadChildren(db, scope, ids, 'all'), rootId) : [];
}

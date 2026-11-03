import { sql } from 'drizzle-orm';
import type { ProjectScope } from '../../infrastructure/types';

/** A board's project and workspace must match the explicit query scope. */
export function boardInProjectScope(scope: ProjectScope, boardId: string) {
  return sql`EXISTS (
    SELECT 1 FROM boards b
    JOIN projects p ON p.id = b.project_id AND p.workspace_id = b.workspace_id
    WHERE b.id = ${boardId}
      AND b.workspace_id = ${scope.workspaceId}
      AND b.project_id = ${scope.projectId}
  )`;
}

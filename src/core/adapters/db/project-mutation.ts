import { sql } from 'drizzle-orm';
import type { ProjectMoveSnapshot, ProjectPosition } from '../../infrastructure/types';

/** Shared write predicates are evaluated inside each adapter's commit boundary. */
export function projectEditor(workspaceId: string, userId: string) {
  return sql`EXISTS (SELECT 1 FROM members WHERE workspace_id = ${workspaceId}
    AND user_id = ${userId} AND role IN ('editor', 'owner'))`;
}

export function projectOwner(workspaceId: string, userId: string) {
  return sql`EXISTS (SELECT 1 FROM members WHERE workspace_id = ${workspaceId}
    AND user_id = ${userId} AND role = 'owner')`;
}

function activeProject(workspaceId: string, project: ProjectPosition) {
  return sql`EXISTS (SELECT 1 FROM projects WHERE workspace_id = ${workspaceId}
    AND archived_at IS NULL AND id = ${project.id} AND position = ${project.position})`;
}

type Dialect = 'sqlite' | 'postgres';

function after(project: ProjectPosition, dialect: Dialect) {
  const position = sql.raw(
    dialect === 'postgres' ? 'position COLLATE "C"' : 'position COLLATE BINARY',
  );
  const id = sql.raw(dialect === 'postgres' ? 'id COLLATE "C"' : 'id COLLATE BINARY');
  return sql`(${position} > ${project.position} OR (${position} = ${project.position} AND ${id} > ${project.id}))`;
}

function before(project: ProjectPosition, dialect: Dialect) {
  const position = sql.raw(
    dialect === 'postgres' ? 'position COLLATE "C"' : 'position COLLATE BINARY',
  );
  const id = sql.raw(dialect === 'postgres' ? 'id COLLATE "C"' : 'id COLLATE BINARY');
  return sql`(${position} < ${project.position} OR (${position} = ${project.position} AND ${id} < ${project.id}))`;
}

export function projectTail(
  workspaceId: string,
  last: ProjectPosition | null,
  newPosition: string,
  dialect: Dialect,
) {
  if (last && newPosition <= last.position) return sql`1 = 0`;
  if (!last)
    return sql`NOT EXISTS (SELECT 1 FROM projects WHERE workspace_id = ${workspaceId} AND archived_at IS NULL)`;
  return sql`${activeProject(workspaceId, last)} AND NOT EXISTS (SELECT 1 FROM projects
    WHERE workspace_id = ${workspaceId} AND archived_at IS NULL AND ${after(last, dialect)})`;
}

export function projectGap(
  workspaceId: string,
  projectId: string,
  snapshot: ProjectMoveSnapshot,
  newPosition: string,
  dialect: Dialect,
) {
  const { previous, next } = snapshot;
  if (
    previous?.id === projectId ||
    next?.id === projectId ||
    (previous && next && previous.position >= next.position) ||
    (previous && newPosition <= previous.position) ||
    (next && newPosition >= next.position)
  ) {
    return sql`1 = 0`;
  }
  return sql`${previous ? activeProject(workspaceId, previous) : sql`1 = 1`}
    AND ${next ? activeProject(workspaceId, next) : sql`1 = 1`}
    AND NOT EXISTS (SELECT 1 FROM projects WHERE workspace_id = ${workspaceId}
      AND archived_at IS NULL AND id <> ${projectId}
      ${previous ? sql`AND ${after(previous, dialect)}` : sql``}
      ${next ? sql`AND ${before(next, dialect)}` : sql``})`;
}

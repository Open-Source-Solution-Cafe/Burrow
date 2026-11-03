import type { DB } from '../client';
import * as t from '../schema';
import { and, eq, isNull, sql } from 'drizzle-orm';
import type { BatchItem } from 'drizzle-orm/batch';
import type { IProjectRepository, Project } from '../../../../infrastructure/types';
import { projectEditor, projectGap, projectOwner, projectTail } from '../../project-mutation';
import { runBatch } from '../lib/batch';

export function createProjectRepository(db: DB): IProjectRepository {
  return {
    async listByWorkspace(workspaceId: string): Promise<Project[]> {
      const rows = await db
        .select()
        .from(t.projects)
        .where(and(eq(t.projects.workspaceId, workspaceId), isNull(t.projects.archivedAt)))
        .orderBy(sql`${t.projects.position} COLLATE BINARY`, sql`${t.projects.id} COLLATE BINARY`);
      return rows.map(mapProject);
    },

    async findByIdForMember(projectId: string, userId: string): Promise<Project | null> {
      const [row] = await db
        .select({ project: t.projects })
        .from(t.projects)
        .innerJoin(t.members, eq(t.members.workspaceId, t.projects.workspaceId))
        .where(and(eq(t.projects.id, projectId), eq(t.members.userId, userId)));
      return row ? mapProject(row.project) : null;
    },

    async findByIdAndWorkspace(id: string, workspaceId: string): Promise<Project | null> {
      const [row] = await db
        .select()
        .from(t.projects)
        .where(and(eq(t.projects.id, id), eq(t.projects.workspaceId, workspaceId)));
      return row ? mapProject(row) : null;
    },

    async createGuarded(data, actorUserId, expectedLast) {
      const rows = await db.all<{ id: string }>(sql`INSERT INTO projects
        (id, workspace_id, name, icon, color, position, created_at, updated_at)
        SELECT ${data.id}, ${data.workspaceId}, ${data.name}, ${data.icon ?? null},
          ${data.color ?? null}, ${data.position}, ${data.createdAt}, ${data.updatedAt}
        WHERE ${projectEditor(data.workspaceId, actorUserId)}
          AND ${projectTail(data.workspaceId, expectedLast, data.position, 'sqlite')}
        RETURNING id`);
      return rows.length === 1;
    },

    async updateGuarded(workspaceId, actorUserId, projectId, data) {
      const rows = await db
        .update(t.projects)
        .set(data)
        .where(
          and(
            eq(t.projects.id, projectId),
            eq(t.projects.workspaceId, workspaceId),
            projectEditor(workspaceId, actorUserId),
          ),
        )
        .returning({ id: t.projects.id });
      return rows.length === 1;
    },

    async moveGuarded(workspaceId, actorUserId, projectId, position, expected) {
      const rows = await db
        .update(t.projects)
        .set({ position, updatedAt: Date.now() })
        .where(
          and(
            eq(t.projects.id, projectId),
            eq(t.projects.workspaceId, workspaceId),
            eq(t.projects.position, expected.targetPosition),
            projectEditor(workspaceId, actorUserId),
            projectGap(workspaceId, projectId, expected, position, 'sqlite'),
          ),
        )
        .returning({ id: t.projects.id });
      return rows.length === 1;
    },

    async hardDeleteGuarded(workspaceId, actorUserId, projectId, confirmName) {
      const [member] = await db
        .select({ userId: t.members.userId })
        .from(t.members)
        .where(
          and(
            eq(t.members.workspaceId, workspaceId),
            eq(t.members.userId, actorUserId),
            eq(t.members.role, 'owner'),
          ),
        );
      if (!member) return null;

      const [project] = await db
        .select({ id: t.projects.id, name: t.projects.name })
        .from(t.projects)
        .where(and(eq(t.projects.id, projectId), eq(t.projects.workspaceId, workspaceId)));
      if (!project || project.name !== confirmName) return null;

      const scopeIssues = await db.all<{ id: string }>(sql`
        SELECT n.id FROM notepads n JOIN projects p ON p.id = n.project_id
        WHERE p.id = ${projectId} AND (n.workspace_id <> p.workspace_id OR EXISTS (
          SELECT 1 FROM notepads child WHERE child.parent_id = n.id
            AND (child.project_id <> p.id OR child.workspace_id <> p.workspace_id)))
        UNION ALL
        SELECT n.id FROM boards b JOIN projects p ON p.id = b.project_id
          JOIN cards c ON c.board_id = b.id JOIN notepads n ON n.id = c.notepad_id
        WHERE p.id = ${projectId} AND (b.workspace_id <> p.workspace_id
          OR n.project_id <> p.id OR n.workspace_id <> p.workspace_id)
      `);
      if (scopeIssues.length > 0) throw new Error('project_scope_conflict');

      const owner = projectOwner(workspaceId, actorUserId);
      const deleteAllowed = sql`EXISTS (SELECT 1 FROM projects
        WHERE id = ${projectId} AND workspace_id = ${workspaceId} AND name = ${confirmName})
        AND ${owner}`;
      const statements: BatchItem<'sqlite'>[] = [
        db.run(sql`SELECT storage_key FROM project_files
          WHERE project_id = ${projectId} AND ${deleteAllowed} /* RETURNING */`),
        db.run(sql`DELETE FROM notepads_fts WHERE notepad_id IN (
          SELECT id FROM notepads WHERE project_id = ${projectId} AND workspace_id = ${workspaceId}
        ) AND ${deleteAllowed}`),
        db.run(sql`DELETE FROM notepad_links WHERE target_type IN ('notepad', 'card')
          AND target_id IN (SELECT id FROM notepads WHERE project_id = ${projectId}
            AND workspace_id = ${workspaceId}) AND ${deleteAllowed}`),
        db
          .delete(t.projects)
          .where(
            and(
              eq(t.projects.id, projectId),
              eq(t.projects.workspaceId, workspaceId),
              eq(t.projects.name, confirmName),
              owner,
            ),
          ),
      ];
      const result = (await runBatch(db, statements)) as Array<{
        results?: Array<{ storage_key: string }>;
      }>;

      const [remaining] = await db
        .select({ id: t.projects.id })
        .from(t.projects)
        .where(and(eq(t.projects.id, projectId), eq(t.projects.workspaceId, workspaceId)));
      if (remaining) return null;
      return result[0]?.results?.map(({ storage_key }) => storage_key) ?? [];
    },
  };
}

function mapProject(row: typeof t.projects.$inferSelect): Project {
  return {
    id: row.id,
    workspaceId: row.workspaceId,
    name: row.name,
    icon: row.icon,
    color: row.color,
    position: row.position,
    archivedAt: row.archivedAt ?? null,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

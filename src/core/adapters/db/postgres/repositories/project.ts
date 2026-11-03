import type {
  IProjectRepository,
  Project,
  CreateProjectData,
  UpdateProjectData,
  ProjectPosition,
  ProjectMoveSnapshot,
} from '../../../../infrastructure/types';
import { eq, and, inArray, isNull, sql } from 'drizzle-orm';
import type { PostgresDb } from '../index';
import { members, notepadLinks, notepads, projectFiles, projects, workspaces } from '../schema';
import { projectEditor, projectGap, projectOwner, projectTail } from '../../project-mutation';

export class PostgresProjectRepository implements IProjectRepository {
  constructor(private db: PostgresDb) {}

  async listByWorkspace(workspaceId: string): Promise<Project[]> {
    return this.db
      .select()
      .from(projects)
      .where(and(eq(projects.workspaceId, workspaceId), isNull(projects.archivedAt)))
      .orderBy(sql`${projects.position} COLLATE "C"`, sql`${projects.id} COLLATE "C"`);
  }

  async findByIdForMember(projectId: string, userId: string): Promise<Project | null> {
    const result = await this.db
      .select({ project: projects })
      .from(projects)
      .innerJoin(members, eq(members.workspaceId, projects.workspaceId))
      .where(and(eq(projects.id, projectId), eq(members.userId, userId)))
      .limit(1);
    return result[0]?.project ?? null;
  }

  async findByIdAndWorkspace(id: string, workspaceId: string): Promise<Project | null> {
    const result = await this.db
      .select()
      .from(projects)
      .where(and(eq(projects.id, id), eq(projects.workspaceId, workspaceId)))
      .limit(1);
    return result[0] ?? null;
  }

  private async withWorkspace<T>(
    workspaceId: string,
    mutate: (tx: Pick<PostgresDb, 'execute' | 'update'>) => Promise<T>,
  ): Promise<T> {
    return this.db.transaction(async (tx) => {
      await tx
        .select({ id: workspaces.id })
        .from(workspaces)
        .where(eq(workspaces.id, workspaceId))
        .for('update');
      return mutate(tx);
    });
  }

  async createGuarded(
    data: CreateProjectData,
    actorUserId: string,
    expectedLast: ProjectPosition | null,
  ): Promise<boolean> {
    return this.withWorkspace(data.workspaceId, async (tx) => {
      const rows = await tx.execute<{ id: string }>(sql`INSERT INTO projects
        (id, workspace_id, name, icon, color, position, created_at, updated_at)
        SELECT ${data.id}, ${data.workspaceId}, ${data.name}, ${data.icon ?? null},
          ${data.color ?? null}, ${data.position}, ${data.createdAt}, ${data.updatedAt}
        WHERE ${projectEditor(data.workspaceId, actorUserId)}
          AND ${projectTail(data.workspaceId, expectedLast, data.position, 'postgres')}
        RETURNING id`);
      return rows.length === 1;
    });
  }

  async updateGuarded(
    workspaceId: string,
    actorUserId: string,
    projectId: string,
    data: UpdateProjectData,
  ): Promise<boolean> {
    return this.withWorkspace(workspaceId, async (tx) => {
      const rows = await tx
        .update(projects)
        .set(data)
        .where(
          and(
            eq(projects.id, projectId),
            eq(projects.workspaceId, workspaceId),
            projectEditor(workspaceId, actorUserId),
          ),
        )
        .returning({ id: projects.id });
      return rows.length === 1;
    });
  }

  async moveGuarded(
    workspaceId: string,
    actorUserId: string,
    projectId: string,
    position: string,
    expected: ProjectMoveSnapshot,
  ): Promise<boolean> {
    return this.withWorkspace(workspaceId, async (tx) => {
      const rows = await tx
        .update(projects)
        .set({ position, updatedAt: Date.now() })
        .where(
          and(
            eq(projects.id, projectId),
            eq(projects.workspaceId, workspaceId),
            eq(projects.position, expected.targetPosition),
            projectEditor(workspaceId, actorUserId),
            projectGap(workspaceId, projectId, expected, position, 'postgres'),
          ),
        )
        .returning({ id: projects.id });
      return rows.length === 1;
    });
  }

  async hardDeleteGuarded(
    workspaceId: string,
    actorUserId: string,
    projectId: string,
    confirmName: string,
  ): Promise<string[] | null> {
    return this.db.transaction(async (tx) => {
      await tx
        .select({ id: workspaces.id })
        .from(workspaces)
        .where(eq(workspaces.id, workspaceId))
        .for('update');
      const [owner] = await tx
        .select({ userId: members.userId })
        .from(members)
        .where(
          and(
            eq(members.workspaceId, workspaceId),
            eq(members.userId, actorUserId),
            eq(members.role, 'owner'),
          ),
        );
      if (!owner) return null;

      const [project] = await tx
        .select({ id: projects.id, name: projects.name })
        .from(projects)
        .where(and(eq(projects.id, projectId), eq(projects.workspaceId, workspaceId)))
        .limit(1);
      if (!project || project.name !== confirmName) return null;

      const scopeIssues = await tx.execute<{ id: string }>(sql`
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

      const registeredRows = await tx
        .select({ storageKey: projectFiles.storageKey })
        .from(projectFiles)
        .where(eq(projectFiles.projectId, projectId));
      const targetRows = tx
        .select({ id: notepads.id })
        .from(notepads)
        .where(and(eq(notepads.projectId, projectId), eq(notepads.workspaceId, workspaceId)));
      await tx
        .delete(notepadLinks)
        .where(
          and(
            inArray(notepadLinks.targetType, ['notepad', 'card']),
            sql`${notepadLinks.targetId} IN ${targetRows}`,
          ),
        );
      const deleted = await tx
        .delete(projects)
        .where(
          and(
            eq(projects.id, projectId),
            eq(projects.workspaceId, workspaceId),
            eq(projects.name, confirmName),
            projectOwner(workspaceId, actorUserId),
          ),
        )
        .returning({ id: projects.id });
      if (deleted.length !== 1) return null;
      return Array.from(new Set(registeredRows.map(({ storageKey }) => storageKey)));
    });
  }
}

import type { DB } from '../client';
import * as t from '../schema';
import { and, asc, eq, exists, inArray, sql } from 'drizzle-orm';
import { chunkInList } from '../../../../services/utils/chunk';
import type {
  ITagRepository,
  Tag,
  CreateTagData,
  UpdateTagData,
  TagMutationScope,
  ProjectScope,
} from '../../../../infrastructure/types';

export function createTagRepository(db: DB): ITagRepository {
  const writableProject = (scope: TagMutationScope) => exists(
    db.select({ id: t.projects.id }).from(t.projects).innerJoin(t.members, eq(t.members.workspaceId, t.projects.workspaceId)).where(and(
      eq(t.projects.id, scope.projectId), eq(t.projects.workspaceId, scope.workspaceId), eq(t.members.userId, scope.actorUserId),
      scope.minimumRole === 'owner' ? eq(t.members.role, 'owner') : inArray(t.members.role, ['editor', 'owner']),
    )),
  );
  return {
    async listByProject(scope: ProjectScope): Promise<Tag[]> {
      const rows = await db
        .select({ tag: t.tags })
        .from(t.tags)
        .innerJoin(t.projects, eq(t.projects.id, t.tags.projectId))
        .where(and(eq(t.tags.projectId, scope.projectId), eq(t.projects.workspaceId, scope.workspaceId)))
        .orderBy(asc(t.tags.name));
      return rows.map((row) => mapTag(row.tag));
    },

    async findByIdInScope(scope: ProjectScope, id: string): Promise<Tag | null> {
      const [row] = await db
        .select({ tag: t.tags })
        .from(t.tags)
        .innerJoin(t.projects, eq(t.projects.id, t.tags.projectId))
        .where(
          and(
            eq(t.tags.id, id),
            eq(t.tags.projectId, scope.projectId),
            eq(t.projects.workspaceId, scope.workspaceId),
          ),
        );
      return row ? mapTag(row.tag) : null;
    },

    async createGuarded(data: CreateTagData, scope: TagMutationScope): Promise<Tag | null> {
      if (data.projectId !== scope.projectId) return null;
      const result = await db.all<{ id: string }>(sql`INSERT INTO tags (id, project_id, name, color)
        SELECT ${data.id}, ${data.projectId}, ${data.name}, ${data.color ?? null}
        WHERE EXISTS (SELECT 1 FROM projects p JOIN members m ON m.workspace_id = p.workspace_id
          WHERE p.id = ${scope.projectId} AND p.workspace_id = ${scope.workspaceId}
            AND m.user_id = ${scope.actorUserId} AND ${scope.minimumRole === 'owner' ? sql`m.role = 'owner'` : sql`m.role IN ('editor', 'owner')`}) RETURNING id`);
      return result.length ? { ...data, color: data.color ?? null } : null;
    },

    async updateGuarded(id: string, data: UpdateTagData, scope: TagMutationScope): Promise<boolean> {
      const updated = await db.update(t.tags).set(data).where(and(eq(t.tags.id, id), eq(t.tags.projectId, scope.projectId), writableProject(scope))).returning({ id: t.tags.id });
      return updated.length > 0;
    },

    async deleteGuarded(id: string, scope: TagMutationScope): Promise<boolean> {
      const deleted = await db.delete(t.tags).where(and(eq(t.tags.id, id), eq(t.tags.projectId, scope.projectId), writableProject(scope))).returning({ id: t.tags.id });
      return deleted.length > 0;
    },

    async findByName(scope: ProjectScope, name: string): Promise<Tag | null> {
      const [row] = await db
        .select({ tag: t.tags })
        .from(t.tags)
        .innerJoin(t.projects, eq(t.projects.id, t.tags.projectId))
        .where(and(
          eq(t.tags.projectId, scope.projectId),
          eq(t.projects.workspaceId, scope.workspaceId),
          eq(t.tags.name, name),
        ));
      return row ? mapTag(row.tag) : null;
    },

    async validateByProject(scope: ProjectScope, tagIds: string[]): Promise<{ id: string }[]> {
      if (tagIds.length === 0) return [];
      const results: { id: string }[] = [];
      for (const chunk of chunkInList(tagIds, 1)) {
        const rows = await db
          .select({ id: t.tags.id })
          .from(t.tags)
          .innerJoin(t.projects, eq(t.projects.id, t.tags.projectId))
          .where(and(
            eq(t.tags.projectId, scope.projectId),
            eq(t.projects.workspaceId, scope.workspaceId),
            inArray(t.tags.id, chunk),
          ));
        results.push(...rows);
      }
      return results;
    },

    async findByPattern(
      scope: ProjectScope,
      pattern: string,
      limit: number,
    ): Promise<{ id: string; name: string; color: string | null }[]> {
      const searchPattern = `%${pattern}%`;
      const rows = await db
        .select({ id: t.tags.id, name: t.tags.name, color: t.tags.color })
        .from(t.tags)
        .innerJoin(t.projects, eq(t.projects.id, t.tags.projectId))
        .where(
          and(
            eq(t.tags.projectId, scope.projectId),
            eq(t.projects.workspaceId, scope.workspaceId),
            sql`${t.tags.name} LIKE ${searchPattern}`,
          ),
        )
        .orderBy(asc(t.tags.name))
        .limit(limit);
      return rows.map((r) => ({ id: r.id, name: r.name, color: r.color }));
    },
  };
}

function mapTag(row: typeof t.tags.$inferSelect): Tag {
  return {
    id: row.id,
    projectId: row.projectId,
    name: row.name,
    color: row.color,
  };
}

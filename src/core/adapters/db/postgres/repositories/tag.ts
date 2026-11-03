import type {
  ITagRepository,
  Tag,
  CreateTagData,
  UpdateTagData,
  ProjectScope,
} from '../../../../infrastructure/types';
import { eq, and, sql, inArray } from 'drizzle-orm';
import type { PostgresDb } from '../index';
import { tags, projects } from '../schema';
import type { TagMutationScope } from '../../../../infrastructure/types';
import { withNotepadWrite } from '../notepad-transaction';

export class PostgresTagRepository implements ITagRepository {
  constructor(private db: PostgresDb) {}

  async createGuarded(data: CreateTagData, scope: TagMutationScope): Promise<Tag | null> {
    if (data.projectId !== scope.projectId) return null;
    return withNotepadWrite(this.db, scope, async (tx) => {
      const [project] = await tx.select({ id: projects.id }).from(projects).where(and(eq(projects.id, scope.projectId), eq(projects.workspaceId, scope.workspaceId)));
      if (!project) return null;
      const [created] = await tx.insert(tags).values(data).returning();
      return created ?? null;
    });
  }

  async updateGuarded(id: string, data: UpdateTagData, scope: TagMutationScope): Promise<boolean> {
    return (await withNotepadWrite(this.db, scope, async (tx) => {
      const [updated] = await tx.update(tags).set(data).where(and(eq(tags.id, id), eq(tags.projectId, scope.projectId), sql`exists (select 1 from projects p where p.id = ${tags.projectId} and p.workspace_id = ${scope.workspaceId})`)).returning({ id: tags.id });
      return Boolean(updated);
    })) ?? false;
  }

  async deleteGuarded(id: string, scope: TagMutationScope): Promise<boolean> {
    return (await withNotepadWrite(this.db, scope, async (tx) => {
      const [deleted] = await tx.delete(tags).where(and(eq(tags.id, id), eq(tags.projectId, scope.projectId), sql`exists (select 1 from projects p where p.id = ${tags.projectId} and p.workspace_id = ${scope.workspaceId})`)).returning({ id: tags.id });
      return Boolean(deleted);
    })) ?? false;
  }

  async listByProject(scope: ProjectScope): Promise<Tag[]> {
    const rows = await this.db
      .select({ tag: tags })
      .from(tags)
      .innerJoin(projects, eq(tags.projectId, projects.id))
      .where(and(eq(tags.projectId, scope.projectId), eq(projects.workspaceId, scope.workspaceId)))
      .orderBy(tags.name);
    return rows.map((row) => row.tag);
  }

  async findByIdInScope(scope: ProjectScope, id: string): Promise<Tag | null> {
    const result = await this.db
      .select({ tag: tags })
      .from(tags)
      .innerJoin(projects, eq(tags.projectId, projects.id))
      .where(
        and(
          eq(tags.id, id),
          eq(tags.projectId, scope.projectId),
          eq(projects.workspaceId, scope.workspaceId),
        ),
      )
      .limit(1);
    return result[0]?.tag ?? null;
  }

  async findByName(scope: ProjectScope, name: string): Promise<Tag | null> {
    const result = await this.db
      .select({ tag: tags })
      .from(tags)
      .innerJoin(projects, eq(tags.projectId, projects.id))
      .where(and(
        eq(tags.projectId, scope.projectId),
        eq(projects.workspaceId, scope.workspaceId),
        eq(tags.name, name),
      ))
      .limit(1);
    return result[0]?.tag ?? null;
  }

  async validateByProject(scope: ProjectScope, tagIds: string[]): Promise<{ id: string }[]> {
    if (tagIds.length === 0) return [];
    const result = await this.db
      .select({ id: tags.id })
      .from(tags)
      .innerJoin(projects, eq(tags.projectId, projects.id))
      .where(and(
        eq(tags.projectId, scope.projectId),
        eq(projects.workspaceId, scope.workspaceId),
        inArray(tags.id, tagIds),
      ));
    return result;
  }

  async findByPattern(
    scope: ProjectScope,
    pattern: string,
    limit: number,
  ): Promise<{ id: string; name: string; color: string | null }[]> {
    return this.db
      .select({ id: tags.id, name: tags.name, color: tags.color })
      .from(tags)
      .innerJoin(projects, eq(tags.projectId, projects.id))
      .where(
        and(
          eq(tags.projectId, scope.projectId),
          eq(projects.workspaceId, scope.workspaceId),
          sql`${tags.name} ILIKE ${`%${pattern}%`}`,
        ),
      )
      .limit(limit);
  }
}

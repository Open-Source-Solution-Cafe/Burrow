import { and, eq, sql } from 'drizzle-orm';
import type { IProjectFileRepository, ProjectFile } from '../../../../infrastructure/types';
import type { PostgresDb } from '../index';
import { projectFiles } from '../schema';

export class PostgresProjectFileRepository implements IProjectFileRepository {
  constructor(private db: PostgresDb) {}

  async register(file: ProjectFile): Promise<boolean> {
    const rows = await this.db
      .insert(projectFiles)
      .values({
        projectId: file.projectId,
        storageKey: file.storageKey,
        contentType: file.contentType,
        filename: file.filename ?? null,
        byteSize: file.byteSize ?? null,
        createdBy: file.createdBy,
        createdAt: file.createdAt,
      })
      .onConflictDoNothing({
        target: [projectFiles.projectId, projectFiles.storageKey],
      })
      .returning({ projectId: projectFiles.projectId });
    return rows.length === 1;
  }

  async findByProjectAndKey(projectId: string, storageKey: string): Promise<ProjectFile | null> {
    const [row] = await this.db
      .select()
      .from(projectFiles)
      .where(
        and(eq(projectFiles.projectId, projectId), eq(projectFiles.storageKey, storageKey)),
      )
      .limit(1);
    if (!row) return null;
    const { filename, byteSize, ...registration } = row;
    return {
      ...registration,
      ...(filename === null ? {} : { filename }),
      ...(byteSize === null ? {} : { byteSize }),
    };
  }

  async countByStorageKey(storageKey: string): Promise<number> {
    const rows = await this.db
      .select({ count: sql<number>`count(*)` })
      .from(projectFiles)
      .where(eq(projectFiles.storageKey, storageKey));
    return Number(rows[0]?.count ?? 0);
  }

  async listProjectIdsByStorageKey(storageKey: string): Promise<string[]> {
    const rows = await this.db
      .selectDistinct({ projectId: projectFiles.projectId })
      .from(projectFiles)
      .where(eq(projectFiles.storageKey, storageKey))
      .orderBy(sql`${projectFiles.projectId} COLLATE "C"`);
    return rows.map(({ projectId }) => projectId);
  }

  async listStorageKeysByProject(projectId: string): Promise<string[]> {
    const rows = await this.db
      .selectDistinct({ storageKey: projectFiles.storageKey })
      .from(projectFiles)
      .where(eq(projectFiles.projectId, projectId))
      .orderBy(sql`${projectFiles.storageKey} COLLATE "C"`);
    return rows.map(({ storageKey }) => storageKey);
  }

  async listAllStorageKeys(): Promise<string[]> {
    const rows = await this.db
      .selectDistinct({ storageKey: projectFiles.storageKey })
      .from(projectFiles)
      .orderBy(sql`${projectFiles.storageKey} COLLATE "C"`);
    return rows.map(({ storageKey }) => storageKey);
  }
}

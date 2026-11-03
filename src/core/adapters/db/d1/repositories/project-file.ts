import { and, eq, sql } from 'drizzle-orm';
import type { DB } from '../client';
import * as t from '../schema';
import type { IProjectFileRepository, ProjectFile } from '../../../../infrastructure/types';

export function createProjectFileRepository(db: DB): IProjectFileRepository {
  return {
    async register(file): Promise<boolean> {
      const rows = await db
        .insert(t.projectFiles)
        .values(file)
        .onConflictDoNothing({
          target: [t.projectFiles.projectId, t.projectFiles.storageKey],
        })
        .returning({ projectId: t.projectFiles.projectId });
      return rows.length === 1;
    },

    async findByProjectAndKey(projectId, storageKey): Promise<ProjectFile | null> {
      const [row] = await db
        .select()
        .from(t.projectFiles)
        .where(
          and(eq(t.projectFiles.projectId, projectId), eq(t.projectFiles.storageKey, storageKey)),
        )
        .limit(1);
      if (!row) return null;
      const { filename, byteSize, ...registration } = row;
      return {
        ...registration,
        ...(filename === null ? {} : { filename }),
        ...(byteSize === null ? {} : { byteSize }),
      };
    },

    async countByStorageKey(storageKey): Promise<number> {
      const [row] = await db
        .select({ count: sql<number>`count(*)` })
        .from(t.projectFiles)
        .where(eq(t.projectFiles.storageKey, storageKey));
      return Number(row?.count ?? 0);
    },

    async listProjectIdsByStorageKey(storageKey): Promise<string[]> {
      const rows = await db
        .selectDistinct({ projectId: t.projectFiles.projectId })
        .from(t.projectFiles)
        .where(eq(t.projectFiles.storageKey, storageKey))
        .orderBy(sql`${t.projectFiles.projectId} COLLATE BINARY`);
      return rows.map(({ projectId }) => projectId);
    },

    async listStorageKeysByProject(projectId): Promise<string[]> {
      const rows = await db
        .selectDistinct({ storageKey: t.projectFiles.storageKey })
        .from(t.projectFiles)
        .where(eq(t.projectFiles.projectId, projectId))
        .orderBy(sql`${t.projectFiles.storageKey} COLLATE BINARY`);
      return rows.map(({ storageKey }) => storageKey);
    },

    async listAllStorageKeys(): Promise<string[]> {
      const rows = await db
        .selectDistinct({ storageKey: t.projectFiles.storageKey })
        .from(t.projectFiles)
        .orderBy(sql`${t.projectFiles.storageKey} COLLATE BINARY`);
      return rows.map(({ storageKey }) => storageKey);
    },
  };
}

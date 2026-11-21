import { and, eq } from 'drizzle-orm';
import type { DB } from '../client';
import * as t from '../schema';
import type {
  IPublicShareRepository,
  ProjectScope,
  PublicShare,
} from '../../../../infrastructure/types';

export function createPublicShareRepository(db: DB): IPublicShareRepository {
  return {
    async findByTarget(scope: ProjectScope, targetType: 'notepad' | 'board', targetId: string) {
      const [row] = await db
        .select()
        .from(t.publicShares)
        .where(
          and(
            eq(t.publicShares.workspaceId, scope.workspaceId),
            eq(t.publicShares.projectId, scope.projectId),
            eq(t.publicShares.targetType, targetType),
            eq(t.publicShares.targetId, targetId),
          ),
        );
      return row ?? null;
    },

    async findByToken(token: string) {
      const [row] = await db
        .select()
        .from(t.publicShares)
        .where(eq(t.publicShares.token, token));
      return row ?? null;
    },

    async upsert(share: PublicShare) {
      await db
        .delete(t.publicShares)
        .where(
          and(
            eq(t.publicShares.projectId, share.projectId),
            eq(t.publicShares.targetType, share.targetType),
            eq(t.publicShares.targetId, share.targetId),
          ),
        );
      await db.insert(t.publicShares).values(share);
      return share;
    },

    async revokeByTarget(scope: ProjectScope, targetType: 'notepad' | 'board', targetId: string) {
      const existing = await this.findByTarget(scope, targetType, targetId);
      if (!existing) return false;
      await db
        .update(t.publicShares)
        .set({ enabled: false })
        .where(
          and(
            eq(t.publicShares.workspaceId, scope.workspaceId),
            eq(t.publicShares.projectId, scope.projectId),
            eq(t.publicShares.targetType, targetType),
            eq(t.publicShares.targetId, targetId),
          ),
        );
      return true;
    },
  };
}

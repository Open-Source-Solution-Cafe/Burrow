import { and, eq } from 'drizzle-orm';
import type { PostgresDb } from '../index';
import { publicShares } from '../schema';
import type {
  IPublicShareRepository,
  ProjectScope,
  PublicShare,
} from '../../../../infrastructure/types';

export class PostgresPublicShareRepository implements IPublicShareRepository {
  constructor(private db: PostgresDb) {}

  async findByTarget(scope: ProjectScope, targetType: 'notepad' | 'board', targetId: string) {
    const [row] = await this.db
      .select()
      .from(publicShares)
      .where(
        and(
          eq(publicShares.workspaceId, scope.workspaceId),
          eq(publicShares.projectId, scope.projectId),
          eq(publicShares.targetType, targetType),
          eq(publicShares.targetId, targetId),
        ),
      )
      .limit(1);
    return row ?? null;
  }

  async findByToken(token: string) {
    const [row] = await this.db
      .select()
      .from(publicShares)
      .where(eq(publicShares.token, token))
      .limit(1);
    return row ?? null;
  }

  async upsert(share: PublicShare) {
    await this.db.transaction(async (tx) => {
      await tx
        .delete(publicShares)
        .where(
          and(
            eq(publicShares.projectId, share.projectId),
            eq(publicShares.targetType, share.targetType),
            eq(publicShares.targetId, share.targetId),
          ),
        );
      await tx.insert(publicShares).values(share);
    });
    return share;
  }

  async revokeByTarget(scope: ProjectScope, targetType: 'notepad' | 'board', targetId: string) {
    const rows = await this.db
      .update(publicShares)
      .set({ enabled: false })
      .where(
        and(
          eq(publicShares.workspaceId, scope.workspaceId),
          eq(publicShares.projectId, scope.projectId),
          eq(publicShares.targetType, targetType),
          eq(publicShares.targetId, targetId),
        ),
      )
      .returning({ id: publicShares.id });
    return rows.length > 0;
  }
}

import type { DB } from '../client';
import * as t from '../schema';
import { and, asc, eq, sql } from 'drizzle-orm';
import type {
  IWorkspaceRepository,
  Workspace,
  WorkspaceMembership,
  WorkspaceProvisioningPlan,
} from '../../../../infrastructure/types';
import { runBatch } from '../lib/batch';
import { ftsInsertNowStmt } from '../lib/search';
import { extractPlainText } from '../../../../../shared/extract';

export function createWorkspaceRepository(db: DB): IWorkspaceRepository {
  const provisionStatements = (plan: WorkspaceProvisioningPlan) => [
    db.insert(t.workspaces).values(plan.workspace),
    db.insert(t.members).values(plan.owner),
    db.insert(t.projects).values(plan.project),
    db.insert(t.notepads).values(plan.notepad),
    db.run(
      ftsInsertNowStmt(plan.notepad.id, plan.notepad.title, extractPlainText(plan.notepad.content)),
    ),
  ];
  return {
    async listByUser(userId: string): Promise<WorkspaceMembership[]> {
      return db
        .select({
          id: t.workspaces.id,
          name: t.workspaces.name,
          role: t.members.role,
          createdAt: t.workspaces.createdAt,
        })
        .from(t.members)
        .innerJoin(t.workspaces, eq(t.workspaces.id, t.members.workspaceId))
        .where(eq(t.members.userId, userId))
        .orderBy(asc(t.workspaces.createdAt), asc(t.workspaces.id));
    },

    async create(plan) {
      try {
        await runBatch(db, provisionStatements(plan));
        return plan.workspace;
      } catch (error) {
        const [workspace] = await db.select().from(t.workspaces).where(eq(t.workspaces.id, plan.workspace.id));
        const [owner] = await db
          .select({ userId: t.members.userId })
          .from(t.members)
          .where(
            and(
              eq(t.members.workspaceId, plan.workspace.id),
              eq(t.members.userId, plan.owner.userId),
              eq(t.members.role, 'owner'),
            ),
          );
        const [project] = await db
          .select({ id: t.projects.id })
          .from(t.projects)
          .where(and(eq(t.projects.id, plan.project.id), eq(t.projects.workspaceId, plan.workspace.id)));
        const [notepad] = await db
          .select({ id: t.notepads.id })
          .from(t.notepads)
          .where(
            and(
              eq(t.notepads.id, plan.notepad.id),
              eq(t.notepads.workspaceId, plan.workspace.id),
              eq(t.notepads.projectId, plan.project.id),
            ),
          );
        if (workspace?.createdBy === plan.owner.userId && owner && project && notepad) return workspace;
        throw error;
      }
    },

    async rename(workspaceId, actorUserId, name) {
      const rows = await db.all<{ id: string }>(sql`UPDATE workspaces SET name = ${name}
        WHERE id = ${workspaceId} AND EXISTS (
          SELECT 1 FROM members WHERE workspace_id = ${workspaceId}
            AND user_id = ${actorUserId} AND role = 'owner'
        ) RETURNING id`);
      return rows.length > 0;
    },

    async claimBootstrap(email) {
      const normalized = email.trim().toLowerCase();
      if (!normalized) return false;
      const rows = await db.all<{ id: number }>(sql`UPDATE bootstrap_state
        SET status = 'claimed', claim_email = ${normalized}
        WHERE id = 1 AND NOT EXISTS (SELECT 1 FROM workspaces)
          AND (status = 'empty' OR (status = 'claimed' AND claim_email = ${normalized}))
        RETURNING id`);
      return rows.length > 0;
    },

    async releaseBootstrap(email) {
      const normalized = email.trim().toLowerCase();
      if (!normalized) return false;
      const rows = await db.all<{ id: number }>(sql`UPDATE bootstrap_state
        SET status = 'empty', claim_email = NULL
        WHERE id = 1 AND NOT EXISTS (SELECT 1 FROM workspaces)
          AND status = 'claimed' AND claim_email = ${normalized}
        RETURNING id`);
      return rows.length > 0;
    },

    async completeBootstrap(email, plan) {
      const normalized = email.trim().toLowerCase();
      const userId = plan.owner.userId;
      const workspaceId = plan.workspace.id;
      if (!normalized) return null;
      try {
        await runBatch(db, [
          // This constraint guard runs in the same write transaction as provisioning.
          db.run(sql`INSERT INTO bootstrap_state (id, status)
            SELECT 1, NULL WHERE NOT EXISTS (
              SELECT 1 FROM bootstrap_state WHERE id = 1 AND status = 'claimed'
                AND claim_email = ${normalized}
                AND EXISTS (SELECT 1 FROM user WHERE id = ${userId}
                  AND lower(trim(email)) = ${normalized})
                AND NOT EXISTS (SELECT 1 FROM workspaces)
            )`),
          db.run(sql`UPDATE bootstrap_state SET status = 'complete', user_id = ${userId},
            workspace_id = ${workspaceId} WHERE id = 1`),
          ...provisionStatements(plan),
        ]);
        return plan.workspace;
      } catch (error) {
        const [state] = await db.all<{
          status: string;
          claimEmail: string | null;
          userId: string | null;
          workspaceId: string | null;
          accountMatches: number;
          workspaceCount: number;
        }>(sql`
          SELECT status, claim_email AS claimEmail, user_id AS userId, workspace_id AS workspaceId,
            EXISTS(SELECT 1 FROM user WHERE id = ${userId} AND lower(trim(email)) = ${normalized}) AS accountMatches,
            (SELECT count(*) FROM workspaces) AS workspaceCount FROM bootstrap_state WHERE id = 1`);
        if (
          state?.status === 'complete' &&
          state.userId === userId &&
          state.accountMatches &&
          state.workspaceId
        ) {
          const [workspace] = await db
            .select()
            .from(t.workspaces)
            .where(eq(t.workspaces.id, state.workspaceId));
          return workspace ?? null;
        }
        if (
          state?.status === 'claimed' &&
          state.claimEmail === normalized &&
          state.accountMatches &&
          !state.workspaceCount
        )
          throw error;
        return null;
      }
    },

    async findById(id: string): Promise<Workspace | null> {
      const [row] = await db.select().from(t.workspaces).where(eq(t.workspaces.id, id));
      return row ?? null;
    },

    async count(): Promise<number> {
      const [row] = await db.select({ count: sql<number>`count(*)` }).from(t.workspaces);
      return row?.count ?? 0;
    },
  };
}

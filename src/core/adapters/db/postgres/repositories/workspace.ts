import type {
  IWorkspaceRepository,
  Workspace,
  WorkspaceMembership,
  WorkspaceProvisioningPlan,
} from '../../../../infrastructure/types';
import { and, asc, eq, sql } from 'drizzle-orm';
import type { PostgresDb } from '../index';
import { workspaces, members, projects, notepads, bootstrapState, user } from '../schema';
import { extractPlainText } from '../../../../../shared/extract';

export class PostgresWorkspaceRepository implements IWorkspaceRepository {
  constructor(private db: PostgresDb) {}

  private async provisionRows(tx: Pick<PostgresDb, 'insert'>, plan: WorkspaceProvisioningPlan) {
    await tx.insert(workspaces).values(plan.workspace);
    await tx.insert(members).values(plan.owner);
    await tx.insert(projects).values(plan.project);
    await tx
      .insert(notepads)
      .values({ ...plan.notepad, plainText: extractPlainText(plan.notepad.content) });
  }

  async claimBootstrap(email: string): Promise<boolean> {
    const normalized = email.trim().toLowerCase();
    if (!normalized) return false;
    const rows = await this.db
      .update(bootstrapState)
      .set({ status: 'claimed', claimEmail: normalized })
      .where(
        and(
          eq(bootstrapState.id, 1),
          sql`NOT EXISTS (SELECT 1 FROM workspaces)`,
          sql`(${bootstrapState.status} = 'empty' OR (${bootstrapState.status} = 'claimed' AND ${bootstrapState.claimEmail} = ${normalized}))`,
        ),
      )
      .returning({ id: bootstrapState.id });
    return rows.length > 0;
  }

  async listByUser(userId: string): Promise<WorkspaceMembership[]> {
    return this.db
      .select({
        id: workspaces.id,
        name: workspaces.name,
        role: members.role,
        createdAt: workspaces.createdAt,
      })
      .from(members)
      .innerJoin(workspaces, eq(workspaces.id, members.workspaceId))
      .where(eq(members.userId, userId))
      .orderBy(asc(workspaces.createdAt), asc(workspaces.id));
  }

  async create(plan: WorkspaceProvisioningPlan): Promise<Workspace> {
    try {
      await this.db.transaction((tx) => this.provisionRows(tx, plan));
      return plan.workspace;
    } catch (error) {
      const [workspace] = await this.db
        .select()
        .from(workspaces)
        .where(eq(workspaces.id, plan.workspace.id));
      const [owner] = await this.db
        .select({ userId: members.userId })
        .from(members)
        .where(
          and(
            eq(members.workspaceId, plan.workspace.id),
            eq(members.userId, plan.owner.userId),
            eq(members.role, 'owner'),
          ),
        );
      const [project] = await this.db
        .select({ id: projects.id })
        .from(projects)
        .where(and(eq(projects.id, plan.project.id), eq(projects.workspaceId, plan.workspace.id)));
      const [notepad] = await this.db
        .select({ id: notepads.id })
        .from(notepads)
        .where(
          and(
            eq(notepads.id, plan.notepad.id),
            eq(notepads.workspaceId, plan.workspace.id),
            eq(notepads.projectId, plan.project.id),
          ),
        );
      if (workspace?.createdBy === plan.owner.userId && owner && project && notepad) return workspace;
      throw error;
    }
  }

  async rename(workspaceId: string, actorUserId: string, name: string): Promise<boolean> {
    return this.db.transaction(async (tx) => {
      await tx.select({ id: workspaces.id }).from(workspaces).where(eq(workspaces.id, workspaceId)).for('update');
      const [owner] = await tx
        .select({ userId: members.userId })
        .from(members)
        .where(and(eq(members.workspaceId, workspaceId), eq(members.userId, actorUserId), eq(members.role, 'owner')));
      if (!owner) return false;
      const updated = await tx
        .update(workspaces)
        .set({ name })
        .where(eq(workspaces.id, workspaceId))
        .returning({ id: workspaces.id });
      return updated.length > 0;
    });
  }

  async completeBootstrap(
    email: string,
    plan: WorkspaceProvisioningPlan,
  ): Promise<Workspace | null> {
    const normalized = email.trim().toLowerCase();
    if (!normalized) return null;
    return this.db.transaction(async (tx) => {
      const [state] = await tx
        .select()
        .from(bootstrapState)
        .where(eq(bootstrapState.id, 1))
        .for('update');
      const [account] = await tx
        .select({ email: user.email })
        .from(user)
        .where(eq(user.id, plan.owner.userId));
      if (!state || !account || account.email.trim().toLowerCase() !== normalized) return null;
      if (state.status === 'complete') {
        if (state.userId !== plan.owner.userId || !state.workspaceId) return null;
        const [workspace] = await tx
          .select()
          .from(workspaces)
          .where(eq(workspaces.id, state.workspaceId));
        return workspace ?? null;
      }
      if (state.status !== 'claimed' || state.claimEmail !== normalized) return null;
      const [existing] = await tx.select({ id: workspaces.id }).from(workspaces).limit(1);
      if (existing) return null;
      await this.provisionRows(tx, plan);
      await tx
        .update(bootstrapState)
        .set({ status: 'complete', userId: plan.owner.userId, workspaceId: plan.workspace.id })
        .where(eq(bootstrapState.id, 1));
      return plan.workspace;
    });
  }

  async findById(id: string): Promise<Workspace | null> {
    const result = await this.db.select().from(workspaces).where(eq(workspaces.id, id)).limit(1);
    return result[0] ?? null;
  }

  async count(): Promise<number> {
    const result = await this.db.select({ count: sql<number>`count(*)` }).from(workspaces);
    return Number(result[0]?.count ?? 0);
  }
}

import type { IInviteRepository, Invite, CreateInviteData } from '../../../../infrastructure/types';
import { eq, and, isNull, gt } from 'drizzle-orm';
import type { PostgresDb } from '../index';
import { invites, members, user } from '../schema';

export class PostgresInviteRepository implements IInviteRepository {
  constructor(private db: PostgresDb) {}

  async listPending(workspaceId: string): Promise<Invite[]> {
    const now = Date.now();
    return this.db
      .select()
      .from(invites)
      .where(
        and(
          eq(invites.workspaceId, workspaceId),
          isNull(invites.acceptedAt),
          gt(invites.expiresAt, now),
        ),
      )
      .orderBy(invites.createdAt);
  }

  async findByTokenHash(tokenHash: string): Promise<Invite | null> {
    const result = await this.db
      .select()
      .from(invites)
      .where(eq(invites.tokenHash, tokenHash))
      .limit(1);
    return result[0] ?? null;
  }

  async create(data: CreateInviteData): Promise<Invite> {
    const result = await this.db.insert(invites).values(data).returning();
    if (!result[0]) throw new Error('Failed to create invite');
    return result[0];
  }

  async acceptForUser(tokenHash: string, userId: string, now: number) {
    return this.db.transaction(async (tx) => {
      // Serialize invite acceptance per account, including different tokens.
      const [account] = await tx.select().from(user).where(eq(user.id, userId)).for('update');
      const [invite] = await tx
        .select()
        .from(invites)
        .where(eq(invites.tokenHash, tokenHash))
        .for('update');
      if (
        !account ||
        !invite ||
        invite.acceptedAt !== null ||
        invite.expiresAt <= Math.max(now, Date.now()) ||
        account.email.trim().toLowerCase() !== invite.email.trim().toLowerCase()
      )
        return null;

      const existing = await tx
        .select()
        .from(members)
        .where(and(eq(members.workspaceId, invite.workspaceId), eq(members.userId, userId)));
      const member =
        existing[0] ??
        (
          await tx
            .insert(members)
            .values({
              workspaceId: invite.workspaceId,
              userId,
              role: invite.role,
              joinedAt: now,
            })
            .returning()
        )[0];
      if (!member) throw new Error('Failed to create invite membership');
      await tx.update(invites).set({ acceptedAt: now }).where(eq(invites.id, invite.id));
      return { workspaceId: invite.workspaceId, role: member.role };
    });
  }

  async delete(id: string, workspaceId: string): Promise<void> {
    await this.db
      .delete(invites)
      .where(and(eq(invites.id, id), eq(invites.workspaceId, workspaceId)));
  }
}

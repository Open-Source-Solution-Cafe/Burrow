import type {
  IMemberRepository,
  Member,
  CreateMemberData,
  ChangeRoleArgs,
  RemoveMemberArgs,
} from '../../../../infrastructure/types';
import { eq, and, inArray, sql } from 'drizzle-orm';
import type { PostgresDb } from '../index';
import { memberMutationError } from '../../member-mutation';
import {
  members,
  user,
  cardAssignees,
  cards,
  boards,
  notepads,
  editLocks,
  workspaces,
} from '../schema';

export class PostgresMemberRepository implements IMemberRepository {
  constructor(private db: PostgresDb) {}

  async listByWorkspace(workspaceId: string): Promise<Member[]> {
    const rows = await this.db
      .select({
        workspaceId: members.workspaceId,
        userId: members.userId,
        role: members.role,
        joinedAt: members.joinedAt,
        name: user.name,
        email: user.email,
        image: user.image,
      })
      .from(members)
      .leftJoin(user, eq(user.id, members.userId))
      .where(eq(members.workspaceId, workspaceId))
      .orderBy(members.joinedAt);
    return rows.map((r) => ({
      workspaceId: r.workspaceId,
      userId: r.userId,
      role: r.role,
      joinedAt: r.joinedAt,
      name: r.name ?? undefined,
      email: r.email ?? undefined,
      image: r.image ?? null,
    }));
  }

  async findByUserId(workspaceId: string, userId: string): Promise<Member | null> {
    const result = await this.db
      .select({
        workspaceId: members.workspaceId,
        userId: members.userId,
        role: members.role,
        joinedAt: members.joinedAt,
        name: user.name,
        email: user.email,
        image: user.image,
      })
      .from(members)
      .leftJoin(user, eq(user.id, members.userId))
      .where(and(eq(members.workspaceId, workspaceId), eq(members.userId, userId)))
      .limit(1);
    if (!result[0]) return null;
    return {
      workspaceId: result[0].workspaceId,
      userId: result[0].userId,
      role: result[0].role,
      joinedAt: result[0].joinedAt,
      name: result[0].name ?? undefined,
      email: result[0].email ?? undefined,
      image: result[0].image ?? null,
    };
  }

  async findByUserIds(workspaceId: string, userIds: string[]): Promise<{ userId: string }[]> {
    if (userIds.length === 0) return [];
    const result = await this.db
      .select({ userId: members.userId })
      .from(members)
      .where(and(eq(members.workspaceId, workspaceId), inArray(members.userId, userIds)));
    return result;
  }

  async findByPattern(
    workspaceId: string,
    pattern: string,
    limit: number,
  ): Promise<{ userId: string; name: string; email: string; image: string | null }[]> {
    return this.db
      .select({
        userId: user.id,
        name: user.name,
        email: user.email,
        image: user.image,
      })
      .from(members)
      .innerJoin(user, eq(members.userId, user.id))
      .where(
        and(
          eq(members.workspaceId, workspaceId),
          sql`(${user.name} ILIKE ${`%${pattern}%`} OR ${user.email} ILIKE ${`%${pattern}%`})`,
        ),
      )
      .limit(limit);
  }

  updateRole(args: ChangeRoleArgs): Promise<void> {
    return this.mutate(args);
  }

  remove(args: RemoveMemberArgs): Promise<void> {
    return this.mutate(args);
  }

  private async mutate(args: ChangeRoleArgs | RemoveMemberArgs): Promise<void> {
    const { workspaceId, targetUserId } = args;
    await this.db.transaction(async (tx) => {
      await tx
        .select({ id: workspaces.id })
        .from(workspaces)
        .where(eq(workspaces.id, workspaceId))
        .for('update');
      const [decision] = await tx.execute<{ error: string | null }>(
        sql`SELECT ${memberMutationError(args)} AS error`,
      );
      if (decision?.error) throw new Error(decision.error);
      if ('newRole' in args) {
        await tx
          .update(members)
          .set({ role: args.newRole })
          .where(and(eq(members.workspaceId, workspaceId), eq(members.userId, targetUserId)));
        return;
      }
      await tx
        .delete(cardAssignees)
        .where(
          and(
            eq(cardAssignees.userId, targetUserId),
            inArray(
              cardAssignees.cardId,
              tx
                .select({ id: cards.id })
                .from(cards)
                .innerJoin(boards, eq(boards.id, cards.boardId))
                .where(eq(boards.workspaceId, workspaceId)),
            ),
          ),
        );
      await tx
        .delete(editLocks)
        .where(
          and(
            eq(editLocks.userId, targetUserId),
            inArray(
              editLocks.notepadId,
              tx
                .select({ id: notepads.id })
                .from(notepads)
                .where(eq(notepads.workspaceId, workspaceId)),
            ),
          ),
        );
      await tx
        .delete(members)
        .where(and(eq(members.workspaceId, workspaceId), eq(members.userId, targetUserId)));
    });
  }

  async create(data: CreateMemberData): Promise<Member> {
    const result = await this.db.insert(members).values(data).returning();
    if (!result[0]) throw new Error('Failed to create member');
    return result[0];
  }

  async userExists(email: string): Promise<boolean> {
    const normalized = email.trim().toLowerCase();
    const [row] = await this.db
      .select({ id: user.id })
      .from(user)
      .where(eq(sql`lower(${user.email})`, normalized))
      .limit(1);
    return Boolean(row);
  }
}

import type { DB } from '../client';
import * as t from '../schema';
import { and, eq, inArray, sql } from 'drizzle-orm';
import { runBatch } from '../lib/batch';
import { memberMutationError } from '../../member-mutation';
import type {
  IMemberRepository,
  Member,
  CreateMemberData,
  ChangeRoleArgs,
  RemoveMemberArgs,
} from '../../../../infrastructure/types';

export function createMemberRepository(db: DB): IMemberRepository {
  const denial = async (args: ChangeRoleArgs | RemoveMemberArgs) =>
    (await db.get<{ error: string | null }>(sql`SELECT ${memberMutationError(args)} AS error`))
      ?.error;
  const mutate = async (args: ChangeRoleArgs | RemoveMemberArgs) => {
    const rejected = await denial(args);
    if (rejected) throw new Error(rejected);
    const { workspaceId, targetUserId } = args;
    // NOT NULL rejects stale authorization/owner state before any cleanup runs.
    const guard = db
      .update(t.workspaces)
      .set({
        name: sql`CASE WHEN ${memberMutationError(args)} IS NULL THEN ${t.workspaces.name} END`,
      })
      .where(eq(t.workspaces.id, workspaceId));
    try {
      await runBatch(
        db,
        'newRole' in args
          ? [
              guard,
              db
                .update(t.members)
                .set({ role: args.newRole })
                .where(
                  and(eq(t.members.workspaceId, workspaceId), eq(t.members.userId, targetUserId)),
                ),
            ]
          : [
              guard,
              db.run(sql`DELETE FROM card_assignees WHERE user_id = ${targetUserId}
          AND card_id IN (SELECT c.id FROM cards c INNER JOIN boards b ON b.id = c.board_id
            WHERE b.workspace_id = ${workspaceId})`),
              db.run(sql`DELETE FROM edit_locks WHERE user_id = ${targetUserId}
          AND notepad_id IN (SELECT id FROM notepads WHERE workspace_id = ${workspaceId})`),
              db
                .delete(t.members)
                .where(
                  and(eq(t.members.workspaceId, workspaceId), eq(t.members.userId, targetUserId)),
                ),
            ],
      );
    } catch (error) {
      for (let cause = error; cause instanceof Error; cause = cause.cause) {
        if (cause.message.includes('NOT NULL constraint failed: workspaces.name')) {
          throw new Error((await denial(args)) || 'forbidden', { cause: error });
        }
      }
      throw error;
    }
  };
  return {
    async listByWorkspace(workspaceId: string): Promise<Member[]> {
      const rows = await db
        .select({
          workspaceId: t.members.workspaceId,
          userId: t.members.userId,
          role: t.members.role,
          joinedAt: t.members.joinedAt,
          name: t.user.name,
          email: t.user.email,
          image: t.user.image,
        })
        .from(t.members)
        .leftJoin(t.user, eq(t.user.id, t.members.userId))
        .where(eq(t.members.workspaceId, workspaceId));
      return rows.map(mapMember);
    },

    async findByUserId(workspaceId: string, userId: string): Promise<Member | null> {
      const [row] = await db
        .select({
          workspaceId: t.members.workspaceId,
          userId: t.members.userId,
          role: t.members.role,
          joinedAt: t.members.joinedAt,
          name: t.user.name,
          email: t.user.email,
          image: t.user.image,
        })
        .from(t.members)
        .leftJoin(t.user, eq(t.user.id, t.members.userId))
        .where(and(eq(t.members.workspaceId, workspaceId), eq(t.members.userId, userId)));
      return row ? mapMember(row) : null;
    },

    async findByUserIds(workspaceId: string, userIds: string[]): Promise<{ userId: string }[]> {
      if (userIds.length === 0) return [];
      const rows = await db
        .select({ userId: t.members.userId })
        .from(t.members)
        .where(and(eq(t.members.workspaceId, workspaceId), inArray(t.members.userId, userIds)));
      return rows;
    },

    async findByPattern(
      workspaceId: string,
      pattern: string,
      limit: number,
    ): Promise<{ userId: string; name: string; email: string; image: string | null }[]> {
      const searchPattern = `%${pattern}%`;
      const rows = await db
        .select({
          userId: t.members.userId,
          name: t.user.name,
          email: t.user.email,
          image: t.user.image,
        })
        .from(t.members)
        .innerJoin(t.user, eq(t.user.id, t.members.userId))
        .where(
          and(eq(t.members.workspaceId, workspaceId), sql`${t.user.name} LIKE ${searchPattern}`),
        )
        .limit(limit);
      return rows;
    },

    updateRole: mutate,
    remove: mutate,

    async create(data: CreateMemberData): Promise<Member> {
      await db.insert(t.members).values(data);
      return data;
    },

    async userExists(email: string): Promise<boolean> {
      const normalized = email.trim().toLowerCase();
      const [row] = await db
        .select({ id: t.user.id })
        .from(t.user)
        .where(eq(sql`lower(${t.user.email})`, normalized))
        .limit(1);
      return Boolean(row);
    },
  };
}

function mapMember(row: {
  workspaceId: string;
  userId: string;
  role: 'owner' | 'editor' | 'viewer';
  joinedAt: number;
  name?: string | null;
  email?: string | null;
  image?: string | null;
}): Member {
  return {
    workspaceId: row.workspaceId,
    userId: row.userId,
    role: row.role,
    joinedAt: row.joinedAt,
    name: row.name ?? undefined,
    email: row.email ?? undefined,
    image: row.image ?? null,
  };
}

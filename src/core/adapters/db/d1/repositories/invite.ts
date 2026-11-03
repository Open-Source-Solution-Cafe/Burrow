import type { DB } from '../client';
import * as t from '../schema';
import { and, eq, gt, isNull, sql } from 'drizzle-orm';
import type { IInviteRepository, Invite, CreateInviteData } from '../../../../infrastructure/types';
import { runBatch } from '../lib/batch';

export function createInviteRepository(db: DB): IInviteRepository {
  return {
    async listPending(workspaceId: string): Promise<Invite[]> {
      const now = Date.now();
      const rows = await db
        .select()
        .from(t.invites)
        .where(
          and(
            eq(t.invites.workspaceId, workspaceId),
            isNull(t.invites.acceptedAt),
            gt(t.invites.expiresAt, now),
          ),
        );
      return rows.map(mapInvite);
    },

    async findByTokenHash(tokenHash: string): Promise<Invite | null> {
      const [row] = await db.select().from(t.invites).where(eq(t.invites.tokenHash, tokenHash));
      return row ? mapInvite(row) : null;
    },

    async create(data: CreateInviteData): Promise<Invite> {
      await db.insert(t.invites).values(data);
      return {
        id: data.id,
        workspaceId: data.workspaceId,
        email: data.email,
        role: data.role,
        tokenHash: data.tokenHash,
        invitedBy: data.invitedBy,
        expiresAt: data.expiresAt,
        acceptedAt: null,
        createdAt: data.createdAt,
      };
    },

    async acceptForUser(tokenHash, userId, now) {
      // The second statement is conditional on the first update in this transaction.
      // A failed insert rolls the invite update back on both D1 and Node SQLite.
      const result = await runBatch(db, [
        db.run(sql`UPDATE invites SET accepted_at = ${now}
          WHERE token_hash = ${tokenHash} AND accepted_at IS NULL AND expires_at > ${now}
            AND expires_at > CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER)
            AND EXISTS (SELECT 1 FROM user WHERE id = ${userId}
              AND lower(trim(email)) = lower(trim(invites.email)))
          RETURNING workspace_id AS workspaceId`),
        db.run(sql`INSERT INTO members (workspace_id, user_id, role, joined_at)
          SELECT workspace_id, ${userId}, role, ${now} FROM invites
          WHERE token_hash = ${tokenHash} AND changes() = 1
          ON CONFLICT DO NOTHING`),
      ]);
      const rows = (result as { results?: { workspaceId: string }[] }[])[0]?.results;
      const workspaceId = rows?.[0]?.workspaceId;
      if (!workspaceId) return null;
      const [member] = await db
        .select({ role: t.members.role })
        .from(t.members)
        .where(and(eq(t.members.workspaceId, workspaceId), eq(t.members.userId, userId)));
      return member ? { workspaceId, role: member.role } : null;
    },

    async delete(id: string, workspaceId: string): Promise<void> {
      await db
        .delete(t.invites)
        .where(and(eq(t.invites.id, id), eq(t.invites.workspaceId, workspaceId)));
    },
  };
}

function mapInvite(row: typeof t.invites.$inferSelect): Invite {
  return {
    id: row.id,
    workspaceId: row.workspaceId,
    email: row.email,
    role: row.role,
    tokenHash: row.tokenHash,
    invitedBy: row.invitedBy,
    expiresAt: row.expiresAt,
    acceptedAt: row.acceptedAt ?? null,
    createdAt: row.createdAt,
  };
}

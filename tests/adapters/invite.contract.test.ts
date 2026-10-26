import { env } from 'cloudflare:test';
import { beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { createD1Db } from '../../src/core/adapters/db/d1/client';
import { createMemberRepository } from '../../src/core/adapters/db/d1/repositories/member';
import { createInviteRepository } from '../../src/core/adapters/db/d1/repositories/invite';
import * as schema from '../../src/core/adapters/db/d1/schema';
import { hashToken } from '../../src/core/shared/crypto';

describe('Invite and Member repository contract', () => {
  let workspaceId = '';

  beforeAll(async () => {
    const db = createD1Db(env.DB);
    workspaceId = crypto.randomUUID();
    await db.insert(schema.workspaces).values({
      id: workspaceId,
      name: 'invite-contract-ws',
      createdBy: 'invite-contract-user',
      createdAt: Date.now(),
    });
  });

  function memberRepo() {
    return createMemberRepository(createD1Db(env.DB));
  }

  function inviteRepo() {
    return createInviteRepository(createD1Db(env.DB));
  }

  describe('memberRepo.userExists', () => {
    it('returns false when user does not exist', async () => {
      const exists = await memberRepo().userExists('nonexistent-contract-user@example.com');
      expect(exists).toBe(false);
    });

    it('returns true when user exists, matching case-insensitively and trimming whitespace', async () => {
      const db = createD1Db(env.DB);
      const userId = crypto.randomUUID();
      const now = Date.now();
      await db.insert(schema.user).values({
        id: userId,
        name: 'Existing User',
        email: 'user-exists-contract@example.com',
        emailVerified: false,
        createdAt: new Date(now),
        updatedAt: new Date(now),
      });

      // Exact match
      expect(await memberRepo().userExists('user-exists-contract@example.com')).toBe(true);

      // Uppercase match
      expect(await memberRepo().userExists('USER-EXISTS-CONTRACT@EXAMPLE.COM')).toBe(true);

      // Mixed-case with whitespace
      expect(await memberRepo().userExists('  User-Exists-Contract@Example.COM  ')).toBe(true);

      // Different email
      expect(await memberRepo().userExists('different-email@example.com')).toBe(false);
    });
  });

  describe('inviteRepo.accept', () => {
    it('successfully accepts an unaccepted invite and returns true; second attempt returns false', async () => {
      const db = createD1Db(env.DB);
      const inviteId = crypto.randomUUID();
      const rawToken = crypto.randomUUID();
      const tokenHash = await hashToken(rawToken);
      const now = Date.now();

      await inviteRepo().create({
        id: inviteId,
        workspaceId,
        email: 'invite-accept-contract@example.com',
        role: 'editor',
        tokenHash,
        invitedBy: 'contract-inviter',
        expiresAt: now + 60_000,
        createdAt: now,
      });

      // First accept should return true
      const firstAccept = await inviteRepo().accept(inviteId);
      expect(firstAccept).toBe(true);

      // Verify acceptedAt is now set in the database
      const [row] = await db
        .select()
        .from(schema.invites)
        .where(eq(schema.invites.id, inviteId));
      expect(row?.acceptedAt).toBeTypeOf('number');

      // Second accept must return false (already accepted)
      const secondAccept = await inviteRepo().accept(inviteId);
      expect(secondAccept).toBe(false);
    });
  });
});

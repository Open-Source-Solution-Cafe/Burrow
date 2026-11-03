import { env } from 'cloudflare:test';
import { describe } from 'vitest';
import { createDb } from '../../src/core/adapters/db/d1/client';
import { createInviteRepository } from '../../src/core/adapters/db/d1/repositories/invite';
import { inviteAcceptCases } from './invite-accept-cases';

describe('D1 invite acceptance', () => {
  inviteAcceptCases(() => ({
    invites: createInviteRepository(createDb(env.DB)),
    async query(text, params = []) {
      return (
        await env.DB.prepare(text)
          .bind(...params)
          .all<Record<string, unknown>>()
      ).results;
    },
    async createUser(id, email, now) {
      await env.DB.prepare(
        'INSERT INTO "user" (id, name, email, "createdAt", "updatedAt") VALUES (?, ?, ?, ?, ?)',
      )
        .bind(id, 'Invited', email, now, now)
        .run();
    },
    async rejectMembership(userId) {
      const name = `reject_invite_${userId.replaceAll('-', '')}`;
      await env.DB.prepare(
        `CREATE TRIGGER ${name} BEFORE INSERT ON members
        WHEN NEW.user_id = '${userId}' BEGIN SELECT RAISE(ABORT, 'forced invite failure'); END`,
      ).run();
    },
  }));
});

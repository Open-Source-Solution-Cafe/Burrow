import { afterEach, beforeEach, describe, inject } from 'vitest';
import { openPersistence, type PersistenceFixture } from './node-fixture';
import { inviteAcceptCases } from './invite-accept-cases';

describe.each(['sqlite', 'postgres'] as const)('%s invite acceptance', (kind) => {
  let fixture: PersistenceFixture;
  beforeEach(async () => {
    fixture = await openPersistence(kind, inject('postgresTestUrl'));
  });
  afterEach(async () => {
    await fixture?.close();
  });
  inviteAcceptCases(() => ({
    ...fixture,
    async createUser(id, email, now) {
      const fields = kind === 'sqlite' ? '"createdAt", "updatedAt"' : 'created_at, updated_at';
      const timestamp = kind === 'sqlite' ? now : new Date(now).toISOString();
      await fixture.query(
        `INSERT INTO "user" (id, name, email, ${fields}) VALUES (?, ?, ?, ?, ?)`,
        [id, 'Invited', email, timestamp, timestamp],
      );
    },
    async rejectMembership(userId) {
      const name = `reject_invite_${userId.replaceAll('-', '')}`;
      if (kind === 'sqlite') {
        await fixture.query(`CREATE TRIGGER ${name} BEFORE INSERT ON members
          WHEN NEW.user_id = '${userId}' BEGIN SELECT RAISE(ABORT, 'forced invite failure'); END`);
      } else {
        await fixture.query(`CREATE FUNCTION ${name}() RETURNS trigger LANGUAGE plpgsql AS $$
          BEGIN IF NEW.user_id = '${userId}' THEN RAISE EXCEPTION 'forced invite failure'; END IF;
          RETURN NEW; END $$`);
        await fixture.query(`CREATE TRIGGER ${name} BEFORE INSERT ON members
          FOR EACH ROW EXECUTE FUNCTION ${name}()`);
      }
    },
  }));
});

import { afterEach, beforeEach, describe, inject } from 'vitest';
import postgres from 'postgres';
import { openPersistence, type PersistenceFixture } from './node-fixture';
import { bootstrapCases } from './bootstrap-cases';

describe.each(['sqlite', 'postgres'] as const)('%s bootstrap contract', (kind) => {
  let fixture: PersistenceFixture;
  let admin: ReturnType<typeof postgres> | undefined;
  let database: string | undefined;
  beforeEach(async () => {
    let url = inject('postgresTestUrl');
    if (kind === 'postgres') {
      admin = postgres(url, { max: 1, onnotice: () => {} });
      database = `bootstrap_${crypto.randomUUID().replaceAll('-', '')}`;
      await admin.unsafe(`CREATE DATABASE "${database}"`);
      const testUrl = new URL(url);
      testUrl.pathname = `/${database}`;
      url = testUrl.toString();
    }
    fixture = await openPersistence(kind, url);
  });
  afterEach(async () => {
    await fixture?.close();
    if (admin && database) await admin.unsafe(`DROP DATABASE "${database}" WITH (FORCE)`);
    await admin?.end();
  });
  bootstrapCases(() => ({
    ...fixture,
    async createUser(id, email, now) {
      const fields = kind === 'sqlite' ? '"createdAt", "updatedAt"' : 'created_at, updated_at';
      const timestamp = kind === 'sqlite' ? now : new Date(now).toISOString();
      await fixture.query(
        `INSERT INTO "user" (id, name, email, ${fields}) VALUES (?, ?, ?, ?, ?)`,
        [id, 'Bootstrap', email, timestamp, timestamp],
      );
    },
  }));
});

import { afterEach, beforeEach, describe, inject } from 'vitest';
import postgres from 'postgres';
import { openPersistence, type PersistenceFixture } from './node-fixture';
import { workspaceProvisioningCases } from './workspace-provision-cases';

describe.each(['sqlite', 'postgres'] as const)('%s workspace provisioning contract', (kind) => {
  let fixture: PersistenceFixture;
  let admin: ReturnType<typeof postgres> | undefined;
  let database: string | undefined;
  beforeEach(async () => {
    let url = inject('postgresTestUrl');
    if (kind === 'postgres') {
      admin = postgres(url, { max: 1, onnotice: () => {} });
      database = `workspace_${crypto.randomUUID().replaceAll('-', '')}`;
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
  workspaceProvisioningCases(() => ({
    ...fixture,
    async createUser(id, email, now) {
      const fields = kind === 'sqlite' ? '"createdAt", "updatedAt"' : 'created_at, updated_at';
      const timestamp = kind === 'sqlite' ? now : new Date(now).toISOString();
      await fixture.query(
        `INSERT INTO "user" (id, name, email, ${fields}) VALUES (?, ?, ?, ?, ?)`,
        [id, 'Bootstrap', email, timestamp, timestamp],
      );
    },
    async indexCount(id) {
      const [row] = await fixture.query(
        kind === 'sqlite'
          ? 'SELECT count(*) AS count FROM notepads_fts WHERE notepad_id = ?'
          : 'SELECT count(*) AS count FROM notepads WHERE id = ? AND search_vector IS NOT NULL',
        [id],
      );
      return Number(row?.count ?? 0);
    },
  }));
});

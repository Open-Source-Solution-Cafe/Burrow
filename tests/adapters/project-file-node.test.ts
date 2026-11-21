import postgres from 'postgres';
import { describe, inject, it } from 'vitest';
import { openPersistence, type PersistenceFixture } from './node-fixture';
import { assertProjectFileRegistry } from './project-file-cases';

describe.each(['sqlite', 'postgres'] as const)('%s project file registry', (kind) => {
  it('registers project/key pairs and lists shared keys consistently', async () => {
    let url = kind === 'postgres' ? inject('postgresTestUrl') : '';
    let admin: ReturnType<typeof postgres> | undefined;
    let database: string | undefined;
    let fixture: PersistenceFixture | undefined;
    try {
      if (kind === 'postgres') {
        admin = postgres(url, { max: 1, onnotice: () => {} });
        database = `project_file_${crypto.randomUUID().replaceAll('-', '')}`;
        await admin.unsafe(`CREATE DATABASE "${database}"`);
        const testUrl = new URL(url);
        testUrl.pathname = `/${database}`;
        url = testUrl.toString();
      }
      fixture = await openPersistence(kind, url);
      await assertProjectFileRegistry(fixture.projectFiles, fixture.query);
    } finally {
      await fixture?.close();
      if (admin && database) await admin.unsafe(`DROP DATABASE "${database}" WITH (FORCE)`);
      await admin?.end();
    }
  });
});

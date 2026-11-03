import { describe, inject, it } from 'vitest';
import { openPersistence } from './node-fixture';
import { assertProjectMutations } from './project-mutation-cases';

describe.each(['sqlite', 'postgres'] as const)('%s project mutation', (kind) => {
  it('guards mutation scope, membership and ordering', async () => {
    const fixture = await openPersistence(kind, inject('postgresTestUrl'));
    try {
      await assertProjectMutations(fixture.projects, fixture.createMembers(), fixture.query, kind);
    } finally {
      await fixture.close();
    }
  });
});

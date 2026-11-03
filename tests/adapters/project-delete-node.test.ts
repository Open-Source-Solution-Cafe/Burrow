import { describe, inject, it } from 'vitest';
import { openPersistence } from './node-fixture';
import { assertProjectDeleteGuard } from './project-delete-cases';

describe.each(['sqlite', 'postgres'] as const)('%s guarded project deletion', (kind) => {
  it('guards project scope, owner role and confirmation and rolls back dependent-row failures', async () => {
    const fixture = await openPersistence(
      kind,
      kind === 'postgres' ? inject('postgresTestUrl') : '',
    );
    try {
      await assertProjectDeleteGuard(fixture.projects, fixture.query, kind);
    } finally {
      await fixture.close();
    }
  });
});

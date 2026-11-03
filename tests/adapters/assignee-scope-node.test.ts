import { describe, inject, it } from 'vitest';
import { openPersistence } from './node-fixture';
import { assertAssigneeScope } from './assignee-scope-cases';

describe.each(['sqlite', 'postgres'] as const)('%s assignee and lock scope', (kind) => {
  it('only exposes current workspace member metadata', async () => {
    const fixture = await openPersistence(kind, inject('postgresTestUrl'));
    try {
      await assertAssigneeScope(fixture, fixture.query, kind);
    } finally {
      await fixture.close();
    }
  });
});

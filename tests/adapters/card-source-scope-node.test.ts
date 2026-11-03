import { describe, inject, it } from 'vitest';
import { openPersistence } from './node-fixture';
import { assertCardSourceScope } from './card-source-scope-cases';

describe.each(['sqlite', 'postgres'] as const)('%s card source scope', (kind) => {
  it('rejects inconsistent card ownership while preserving valid trash lookup', async () => {
    const fixture = await openPersistence(kind, inject('postgresTestUrl'));
    try {
      await assertCardSourceScope(fixture, fixture.query, kind);
    } finally {
      await fixture.close();
    }
  });
});

import { describe, inject, it } from 'vitest';
import { openPersistence } from './node-fixture';
import { assertCardSummaryScope } from './summary-scope-cases';

describe.each(['sqlite', 'postgres'] as const)('%s summary scope', (kind) => {
  it('includes only consistent live cards and member profiles in the requested project', async () => {
    const fixture = await openPersistence(kind, inject('postgresTestUrl'));
    try {
      await assertCardSummaryScope(fixture.cards, fixture.query, kind);
    } finally {
      await fixture.close();
    }
  });
});

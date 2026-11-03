import { describe, inject, it } from 'vitest';
import { openPersistence } from './node-fixture';
import { assertTagScope } from './tag-scope-cases';

describe.each(['sqlite', 'postgres'] as const)('%s tag scope', (kind) => {
  it('only exposes tags from the source project', async () => {
    const fixture = await openPersistence(kind, inject('postgresTestUrl'));
    try {
      await assertTagScope(fixture, fixture.query, kind);
    } finally {
      await fixture.close();
    }
  });
});

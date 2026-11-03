import { describe, inject, it } from 'vitest';
import { openPersistence } from './node-fixture';
import { assertNoteSourceScope } from './note-source-scope-cases';

describe.each(['sqlite', 'postgres'] as const)('%s note source scope', (kind) => {
  it('excludes notes whose stored workspace differs from their project', async () => {
    const fixture = await openPersistence(kind, inject('postgresTestUrl'));
    try {
      await assertNoteSourceScope(fixture.notepads, fixture.query, kind);
    } finally {
      await fixture.close();
    }
  });
});

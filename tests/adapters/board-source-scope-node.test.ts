import { describe, inject, it } from 'vitest';
import { openPersistence } from './node-fixture';
import { assertBoardSourceScope } from './board-source-scope-cases';

describe.each(['sqlite', 'postgres'] as const)('%s board source scope', (kind) => {
  it('excludes boards whose stored workspace differs from their project', async () => {
    const fixture = await openPersistence(kind, inject('postgresTestUrl'));
    try {
      await assertBoardSourceScope(fixture.boards, fixture.query, kind);
    } finally {
      await fixture.close();
    }
  });
});

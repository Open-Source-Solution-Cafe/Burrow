import { describe, inject, it } from 'vitest';
import { openPersistence } from './node-fixture';
import { assertBoardLifecycleScope } from './board-lifecycle-scope-cases';

describe.each(['sqlite', 'postgres'] as const)('%s board lifecycle scope', (kind) => {
  it('leaves inconsistent card sources and foreign links untouched', async () => {
    const fixture = await openPersistence(kind, inject('postgresTestUrl'));
    try {
      await assertBoardLifecycleScope(fixture.boards, fixture.query, kind);
    } finally {
      await fixture.close();
    }
  });
});

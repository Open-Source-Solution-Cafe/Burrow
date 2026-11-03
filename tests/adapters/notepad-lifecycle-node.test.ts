import { describe, inject, it } from 'vitest';
import { openPersistence } from './node-fixture';
import { assertNotepadLifecycle } from './notepad-lifecycle-cases';

describe.each(['sqlite', 'postgres'] as const)('%s notepad lifecycle', (kind) => {
  it('deletes only the intended subtree and preserves independently deleted descendants', async () => {
    const fixture = await openPersistence(
      kind,
      kind === 'postgres' ? inject('postgresTestUrl') : '',
    );
    try {
      await assertNotepadLifecycle(fixture.notepads, fixture.query);
    } finally {
      await fixture.close();
    }
  });
});

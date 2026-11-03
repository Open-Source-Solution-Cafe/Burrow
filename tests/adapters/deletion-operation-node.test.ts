import { describe, inject, it } from 'vitest';
import { openPersistence } from './node-fixture';
import {
  assertBoardDeletionOperations,
  assertNotepadDeletionOperations,
} from './deletion-operation-cases';

describe.each(['sqlite', 'postgres'] as const)('%s deletion operation identity', (kind) => {
  it('restores only the intended notepad deletion operation', async () => {
    const fixture = await openPersistence(
      kind,
      kind === 'postgres' ? inject('postgresTestUrl') : '',
    );
    try {
      await assertNotepadDeletionOperations(fixture.notepads, fixture.query, kind);
    } finally {
      await fixture.close();
    }
  });

  it('restores only card bodies deleted by the board operation', async () => {
    const fixture = await openPersistence(
      kind,
      kind === 'postgres' ? inject('postgresTestUrl') : '',
    );
    try {
      await assertBoardDeletionOperations(
        fixture.boards,
        fixture.notepads,
        fixture.query,
        kind,
      );
    } finally {
      await fixture.close();
    }
  });
});

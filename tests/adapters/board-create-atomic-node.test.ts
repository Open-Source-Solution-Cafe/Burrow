import { afterEach, beforeEach, describe, inject } from 'vitest';
import { openPersistence, type PersistenceFixture } from './node-fixture';
import { boardCreateAtomicCases } from './board-create-atomic-cases';

describe.each(['sqlite', 'postgres'] as const)('%s atomic board creation contract', (kind) => {
  let fixture: PersistenceFixture;

  beforeEach(async () => {
    fixture = await openPersistence(kind, kind === 'postgres' ? inject('postgresTestUrl') : '');
  });

  afterEach(async () => {
    await fixture?.close();
  });

  boardCreateAtomicCases(() => fixture);
});

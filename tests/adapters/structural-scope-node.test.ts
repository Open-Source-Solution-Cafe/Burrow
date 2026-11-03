import { afterEach, beforeEach, describe, inject } from 'vitest';
import { openPersistence, type PersistenceFixture } from './node-fixture';
import { structuralScopeDeleteCases } from './structural-scope-cases';

describe.each(['sqlite', 'postgres'] as const)('%s structural scope delete contract', (kind) => {
  let fixture: PersistenceFixture;

  beforeEach(async () => {
    fixture = await openPersistence(kind, kind === 'postgres' ? inject('postgresTestUrl') : '');
  });

  afterEach(async () => {
    await fixture?.close();
  });

  structuralScopeDeleteCases(() => fixture);
});

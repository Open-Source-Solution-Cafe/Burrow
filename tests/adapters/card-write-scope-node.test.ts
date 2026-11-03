import { afterEach, beforeEach, describe, inject } from 'vitest';
import { openPersistence, type PersistenceFixture } from './node-fixture';
import { cardWriteScopeCases } from './card-write-scope-cases';

describe.each(['sqlite', 'postgres'] as const)('%s atomic card write scope contract', (kind) => {
  let fixture: PersistenceFixture;
  beforeEach(async () => { fixture = await openPersistence(kind, kind === 'postgres' ? inject('postgresTestUrl') : ''); });
  afterEach(async () => { await fixture?.close(); });
  cardWriteScopeCases(() => fixture, kind);
});

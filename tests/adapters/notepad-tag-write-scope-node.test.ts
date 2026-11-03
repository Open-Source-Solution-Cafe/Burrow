import { afterEach, beforeEach, describe, inject } from 'vitest';
import { openPersistence, type PersistenceFixture } from './node-fixture';
import { notepadWriteScopeCases, tagWriteScopeCases } from './notepad-tag-write-scope-cases';

describe.each(['sqlite', 'postgres'] as const)('%s note and tag write scope contract', (kind) => {
  let fixture: PersistenceFixture;
  beforeEach(async () => { fixture = await openPersistence(kind, kind === 'postgres' ? inject('postgresTestUrl') : ''); });
  afterEach(async () => { await fixture?.close(); });
  notepadWriteScopeCases(() => fixture, kind);
  tagWriteScopeCases(() => fixture, kind);
});

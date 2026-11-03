import { describe, inject, it } from 'vitest';
import { openPersistence } from './node-fixture';
import { assertProjectFileRegistry } from './project-file-cases';

describe.each(['sqlite', 'postgres'] as const)('%s project file registry', (kind) => {
  it('registers project/key pairs and lists shared keys consistently', async () => {
    const fixture = await openPersistence(
      kind,
      kind === 'postgres' ? inject('postgresTestUrl') : '',
    );
    try {
      await assertProjectFileRegistry(fixture.projectFiles, fixture.query);
    } finally {
      await fixture.close();
    }
  });
});

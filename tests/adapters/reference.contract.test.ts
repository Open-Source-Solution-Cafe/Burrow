import { env } from 'cloudflare:test';
import { it } from 'vitest';
import { createD1Db } from '../../src/core/adapters/db/d1/client';
import { createNotepadRepository } from '../../src/core/adapters/db/d1/repositories/notepad';
import { assertProjectReferenceIsolation } from './reference-scope-cases';

it('validates live project-local references and backlinks on D1', async () => {
  await assertProjectReferenceIsolation({
    notepads: createNotepadRepository(createD1Db(env.DB)),
    query: (text, params = []) =>
      env.DB.prepare(text)
        .bind(...params)
        .all(),
  });
});

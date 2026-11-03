import { env } from 'cloudflare:test';
import { it } from 'vitest';
import { createD1Db } from '../../src/core/adapters/db/d1/client';
import { createNotepadRepository } from '../../src/core/adapters/db/d1/repositories/notepad';
import { assertNoteSourceScope } from './note-source-scope-cases';

it('D1 excludes notes whose stored workspace differs from their project', async () => {
  await assertNoteSourceScope(
    createNotepadRepository(createD1Db(env.DB)),
    async (sql, params = []) => {
      return (
        await env.DB.prepare(sql)
          .bind(...params)
          .all<Record<string, unknown>>()
      ).results;
    },
    'sqlite',
  );
});

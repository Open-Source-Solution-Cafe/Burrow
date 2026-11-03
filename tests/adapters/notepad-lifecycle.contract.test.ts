import { env } from 'cloudflare:test';
import { it } from 'vitest';
import { createD1Db } from '../../src/core/adapters/db/d1/client';
import { createNotepadRepository } from '../../src/core/adapters/db/d1/repositories/notepad';
import { assertNotepadLifecycle } from './notepad-lifecycle-cases';

it('D1 notepad lifecycle deletes only the intended subtree', async () => {
  await assertNotepadLifecycle(
    createNotepadRepository(createD1Db(env.DB)),
    async (sql, params = []) =>
      (
        await env.DB.prepare(sql)
          .bind(...params)
          .all<Record<string, unknown>>()
      ).results,
  );
});

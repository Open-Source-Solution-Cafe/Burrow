import { env } from 'cloudflare:test';
import { it } from 'vitest';
import { createD1Db } from '../../src/core/adapters/db/d1/client';
import { createNotepadRepository } from '../../src/core/adapters/db/d1/repositories/notepad';
import { assertNotepadLifecycle } from './notepad-lifecycle-cases';

it('D1 notepad lifecycle deletes only the intended subtree', async () => {
  await assertNotepadLifecycle(
    createNotepadRepository(createD1Db(env.DB)),
    async (sql, params = []) => {
      const stmt = env.DB.prepare(sql);
      return ((await (params.length ? stmt.bind(...params) : stmt).all<Record<string, unknown>>()).results ?? []) as Record<string, unknown>[];
    },
  );
});

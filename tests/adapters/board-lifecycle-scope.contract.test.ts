import { env } from 'cloudflare:test';
import { it } from 'vitest';
import { createD1Db } from '../../src/core/adapters/db/d1/client';
import { createBoardRepository } from '../../src/core/adapters/db/d1/repositories/board';
import { assertBoardLifecycleScope } from './board-lifecycle-scope-cases';

it('D1 board lifecycle operations leave inconsistent card sources untouched', async () => {
  await assertBoardLifecycleScope(
    createBoardRepository(createD1Db(env.DB)),
    async (sql, params = []) =>
      (
        await env.DB.prepare(sql)
          .bind(...params)
          .all<Record<string, unknown>>()
      ).results,
    'sqlite',
  );
});

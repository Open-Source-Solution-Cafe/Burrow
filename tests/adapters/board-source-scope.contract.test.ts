import { env } from 'cloudflare:test';
import { it } from 'vitest';
import { createD1Db } from '../../src/core/adapters/db/d1/client';
import { createBoardRepository } from '../../src/core/adapters/db/d1/repositories/board';
import { assertBoardSourceScope } from './board-source-scope-cases';

it('D1 excludes boards whose stored workspace differs from their project', async () => {
  await assertBoardSourceScope(
    createBoardRepository(createD1Db(env.DB)),
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

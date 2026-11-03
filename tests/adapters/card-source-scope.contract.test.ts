import { env } from 'cloudflare:test';
import { it } from 'vitest';
import { createD1Db } from '../../src/core/adapters/db/d1/client';
import { createBoardRepository } from '../../src/core/adapters/db/d1/repositories/board';
import { createCardRepository } from '../../src/core/adapters/db/d1/repositories/card';
import { assertCardSourceScope } from './card-source-scope-cases';

it('D1 rejects inconsistent card ownership while preserving valid trash lookup', async () => {
  const db = createD1Db(env.DB);
  await assertCardSourceScope(
    { boards: createBoardRepository(db), cards: createCardRepository(db) },
    async (sql, params = []) =>
      (
        await env.DB.prepare(sql)
          .bind(...params)
          .all<Record<string, unknown>>()
      ).results,
    'sqlite',
  );
});

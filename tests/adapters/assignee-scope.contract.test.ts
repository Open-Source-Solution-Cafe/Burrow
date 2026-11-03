import { env } from 'cloudflare:test';
import { it } from 'vitest';
import { createD1Db } from '../../src/core/adapters/db/d1/client';
import { createBoardRepository } from '../../src/core/adapters/db/d1/repositories/board';
import { createCardRepository } from '../../src/core/adapters/db/d1/repositories/card';
import { assertAssigneeScope } from './assignee-scope-cases';

it('D1 isolates assignees and lock holders to the workspace', async () => {
  const db = createD1Db(env.DB);
  await assertAssigneeScope(
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

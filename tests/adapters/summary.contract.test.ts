import { env } from 'cloudflare:test';
import { it } from 'vitest';
import { createD1Db } from '../../src/core/adapters/db/d1/client';
import { createCardRepository } from '../../src/core/adapters/db/d1/repositories/card';
import { assertCardSummaryScope } from './summary-scope-cases';

it('D1 summaries include only consistent live cards and member profiles in the requested project', async () => {
  await assertCardSummaryScope(
    createCardRepository(createD1Db(env.DB)),
    async (text, params = []) => {
      const result = await env.DB.prepare(text)
        .bind(...params)
        .all<Record<string, unknown>>();
      return result.results;
    },
    'sqlite',
  );
});

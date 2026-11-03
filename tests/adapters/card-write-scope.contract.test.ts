import { env } from 'cloudflare:test';
import { describe } from 'vitest';
import { createD1Db } from '../../src/core/adapters/db/d1/client';
import { createCardRepository } from '../../src/core/adapters/db/d1/repositories/card';
import { cardWriteScopeCases } from './card-write-scope-cases';

describe('D1 atomic card write scope contract', () => {
  cardWriteScopeCases(() => ({
    cards: createCardRepository(createD1Db(env.DB)),
    async query(sql, params = []) {
      const result = await env.DB.prepare(sql).bind(...params).all<Record<string, unknown>>();
      return result.results;
    },
  }), 'sqlite');
});

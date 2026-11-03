import { env } from 'cloudflare:test';
import { describe } from 'vitest';
import { createBoardRepository } from '../../src/core/adapters/db/d1/repositories/board';
import { createD1Db } from '../../src/core/adapters/db/d1/client';
import { boardWriteScopeCases } from './board-write-scope-cases';

describe('D1 atomic board write scope contract', () => {
  boardWriteScopeCases(() => ({
    boards: createBoardRepository(createD1Db(env.DB)),
    async query(sql, params = []) {
      const result = await env.DB.prepare(sql).bind(...params).all<Record<string, unknown>>();
      return result.results;
    },
  }));
});

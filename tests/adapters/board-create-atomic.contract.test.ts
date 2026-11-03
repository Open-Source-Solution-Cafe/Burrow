import { env } from 'cloudflare:test';
import { describe } from 'vitest';
import { createD1Db } from '../../src/core/adapters/db/d1/client';
import { createBoardRepository } from '../../src/core/adapters/db/d1/repositories/board';
import { boardCreateAtomicCases } from './board-create-atomic-cases';

describe('D1 atomic board creation contract', () => {
  boardCreateAtomicCases(() => ({
    boards: createBoardRepository(createD1Db(env.DB)),
    async query(sql, params = []) {
      const result = await env.DB.prepare(sql).bind(...params).all<Record<string, unknown>>();
      return result.results;
    },
  }));
});

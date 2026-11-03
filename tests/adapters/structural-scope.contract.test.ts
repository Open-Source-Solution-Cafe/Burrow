import { env } from 'cloudflare:test';
import { describe } from 'vitest';
import { structuralScopeDeleteCases } from './structural-scope-cases';

describe('D1 structural scope delete contract', () => {
  structuralScopeDeleteCases(() => ({
    async query(sql, params = []) {
      const result = await env.DB.prepare(sql).bind(...params).all<Record<string, unknown>>();
      return result.results;
    },
  }));
});

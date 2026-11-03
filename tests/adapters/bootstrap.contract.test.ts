import { env } from 'cloudflare:test';
import { describe } from 'vitest';
import { createDb } from '../../src/core/adapters/db/d1/client';
import { createWorkspaceRepository } from '../../src/core/adapters/db/d1/repositories/workspace';
import { bootstrapCases } from './bootstrap-cases';

describe('D1 bootstrap contract', () => {
  bootstrapCases(() => ({
    workspaces: createWorkspaceRepository(createDb(env.DB)),
    async query(text, params = []) {
      return (
        await env.DB.prepare(text)
          .bind(...params)
          .all<Record<string, unknown>>()
      ).results;
    },
    async createUser(id, email, now) {
      await env.DB.prepare(
        'INSERT INTO "user" (id, name, email, "createdAt", "updatedAt") VALUES (?, ?, ?, ?, ?)',
      )
        .bind(id, 'Bootstrap', email, now, now)
        .run();
    },
  }));
});

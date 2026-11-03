import { env } from 'cloudflare:test';
import { it } from 'vitest';
import { createD1Db } from '../../src/core/adapters/db/d1/client';
import { createProjectFileRepository } from '../../src/core/adapters/db/d1/repositories/project-file';
import { assertProjectFileRegistry } from './project-file-cases';

it('enforces the project file registry contract in D1', async () => {
  await assertProjectFileRegistry(
    createProjectFileRepository(createD1Db(env.DB)),
    async (sql, params = []) =>
      (await env.DB.prepare(sql).bind(...params).all<Record<string, unknown>>()).results,
  );
});

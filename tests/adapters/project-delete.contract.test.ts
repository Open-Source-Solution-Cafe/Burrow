import { env } from 'cloudflare:test';
import { it } from 'vitest';
import { createD1Db } from '../../src/core/adapters/db/d1/client';
import { createProjectRepository } from '../../src/core/adapters/db/d1/repositories/project';
import { assertProjectDeleteGuard } from './project-delete-cases';

it('guards D1 project deletion and rolls back dependent-row failures', async () => {
  const db = createD1Db(env.DB);
  await assertProjectDeleteGuard(
    createProjectRepository(db),
    async (sql, params = []) =>
      (await env.DB.prepare(sql).bind(...params).all<Record<string, unknown>>()).results,
    'sqlite',
  );
});

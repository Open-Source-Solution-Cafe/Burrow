import { env } from 'cloudflare:test';
import { it } from 'vitest';
import { createD1Db } from '../../src/core/adapters/db/d1/client';
import { createProjectRepository } from '../../src/core/adapters/db/d1/repositories/project';
import { createMemberRepository } from '../../src/core/adapters/db/d1/repositories/member';
import { assertProjectMutations } from './project-mutation-cases';

it('guards D1 project mutations and ordering', async () => {
  const db = createD1Db(env.DB);
  await assertProjectMutations(
    createProjectRepository(db),
    createMemberRepository(db),
    async (sql, params = []) => {
      const result = await env.DB.prepare(sql)
        .bind(...params)
        .all<Record<string, unknown>>();
      return result.results;
    },
    'sqlite',
  );
});

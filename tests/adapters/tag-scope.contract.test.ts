import { env } from 'cloudflare:test';
import { it } from 'vitest';
import { createD1Db } from '../../src/core/adapters/db/d1/client';
import { createBoardRepository } from '../../src/core/adapters/db/d1/repositories/board';
import { createCardRepository } from '../../src/core/adapters/db/d1/repositories/card';
import { createNotepadRepository } from '../../src/core/adapters/db/d1/repositories/notepad';
import { createTagRepository } from '../../src/core/adapters/db/d1/repositories/tag';
import { assertTagScope } from './tag-scope-cases';

it('D1 only exposes tags from the source project', async () => {
  const db = createD1Db(env.DB);
  await assertTagScope(
    {
      boards: createBoardRepository(db),
      cards: createCardRepository(db),
      notepads: createNotepadRepository(db),
      tags: createTagRepository(db),
    },
    async (sql, params = []) => {
      const result = await env.DB.prepare(sql)
        .bind(...params)
        .all<Record<string, unknown>>();
      return result.results;
    },
    'sqlite',
  );
});

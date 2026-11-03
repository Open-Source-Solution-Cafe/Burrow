import { env } from 'cloudflare:test';
import { it } from 'vitest';
import { createD1Db } from '../../src/core/adapters/db/d1/client';
import { createBoardRepository } from '../../src/core/adapters/db/d1/repositories/board';
import { createNotepadRepository } from '../../src/core/adapters/db/d1/repositories/notepad';
import {
  assertBoardDeletionOperations,
  assertNotepadDeletionOperations,
} from './deletion-operation-cases';

it('D1 notepad restore preserves separate and ambiguous legacy deletion groups', async () => {
  const db = createD1Db(env.DB);
  await assertNotepadDeletionOperations(
    createNotepadRepository(db),
    async (sql, params = []) =>
      (
        await env.DB.prepare(sql)
          .bind(...params)
          .all<Record<string, unknown>>()
      ).results,
    'sqlite',
  );
});

it('D1 board restore leaves independently deleted card bodies in trash', async () => {
  const db = createD1Db(env.DB);
  await assertBoardDeletionOperations(
    createBoardRepository(db),
    createNotepadRepository(db),
    async (sql, params = []) =>
      (
        await env.DB.prepare(sql)
          .bind(...params)
          .all<Record<string, unknown>>()
      ).results,
    'sqlite',
  );
});

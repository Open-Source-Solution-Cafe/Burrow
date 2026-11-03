import { env } from 'cloudflare:test';
import { describe, it } from 'vitest';
import { createD1Db } from '../../src/core/adapters/db/d1/client';
import { createNotificationRepository } from '../../src/core/adapters/db/d1/repositories/notification';
import { assertNotificationReadIsolation } from './notification-read-cases';

describe('D1 notification read contract', () => {
  it('isolates read writes by workspace and recipient and preserves prior timestamps', async () => {
    await assertNotificationReadIsolation(
      createNotificationRepository(createD1Db(env.DB)),
      async (text, params = []) => {
        const result = await env.DB.prepare(text)
          .bind(...params)
          .all<Record<string, unknown>>();
        return result.results;
      },
    );
  });
});

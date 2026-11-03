import { env } from 'cloudflare:test';
import { describe } from 'vitest';
import { createD1Infrastructure } from '../../src/core/adapters/db/d1';
import { createDb } from '../../src/core/adapters/db/d1/client';
import { workspaceProvisioningCases } from './workspace-provision-cases';

describe('D1 workspace provisioning contract', () => {
  const infrastructure = createD1Infrastructure(createDb(env.DB), env);
  workspaceProvisioningCases(() => ({
    workspaces: infrastructure.repositories.workspaces,
    search: infrastructure.search,
    async indexCount(id) {
      const row = await env.DB.prepare(
        'SELECT count(*) AS count FROM notepads_fts WHERE notepad_id = ?',
      )
        .bind(id)
        .first<{ count: number }>();
      return row?.count ?? 0;
    },
    async query(text, params = []) {
      const result = await env.DB.prepare(text)
        .bind(...params)
        .all<Record<string, unknown>>();
      return result.results;
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

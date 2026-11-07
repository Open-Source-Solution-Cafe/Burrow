import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { createD1Db } from '../../src/core/adapters/db/d1/client';
import { createMemberRepository } from '../../src/core/adapters/db/d1/repositories/member';
import { assertMemberIsolation } from './member-read-cases';

describe('D1 member repository contract', () => {
  it('observes current memberships and revokes only the selected workspace atomically', async () => {
    await assertMemberIsolation(
      () => createMemberRepository(createD1Db(env.DB)),
      async (text, params = []) => {
        const result = await env.DB.prepare(text)
          .bind(...params)
          .all<Record<string, unknown>>();
        return result.results;
      },
    );
  });

  it('rejects stale actor permissions even if restored before error classification', async () => {
    const workspaceId = crypto.randomUUID(),
      actorUserId = crypto.randomUUID(),
      targetUserId = crypto.randomUUID();
    const projectId = crypto.randomUUID(),
      notepadId = crypto.randomUUID(),
      now = Date.now();
    await env.DB.batch([
      env.DB.prepare(
        "INSERT INTO user (id, name, email, emailVerified, createdAt, updatedAt) VALUES (?, 'Actor', ? || '@test.com', 0, ?, ?)",
      ).bind(actorUserId, actorUserId, now, now),
      env.DB.prepare(
        "INSERT INTO user (id, name, email, emailVerified, createdAt, updatedAt) VALUES (?, 'Target', ? || '@test.com', 0, ?, ?)",
      ).bind(targetUserId, targetUserId, now, now),
      env.DB.prepare(
        "INSERT INTO workspaces (id, name, created_by, created_at) VALUES (?, 'Race', ?, ?)",
      ).bind(workspaceId, actorUserId, now),
      env.DB.prepare(
        "INSERT INTO members (workspace_id, user_id, role, joined_at) VALUES (?, ?, 'owner', ?)",
      ).bind(workspaceId, actorUserId, now),
      env.DB.prepare(
        "INSERT INTO members (workspace_id, user_id, role, joined_at) VALUES (?, ?, 'editor', ?)",
      ).bind(workspaceId, targetUserId, now),
      env.DB.prepare(
        "INSERT INTO projects (id, workspace_id, name, position, created_at, updated_at) VALUES (?, ?, 'Project', 'a0', ?, ?)",
      ).bind(projectId, workspaceId, now, now),
      env.DB.prepare(
        "INSERT INTO notepads (id, workspace_id, project_id, title, position, created_by, created_at, updated_at) VALUES (?, ?, ?, 'Note', 'a0', ?, ?, ?)",
      ).bind(notepadId, workspaceId, projectId, targetUserId, now, now),
      env.DB.prepare(
        "INSERT INTO edit_locks (notepad_id, user_id, client_id, expires_at) VALUES (?, ?, 'race', ?)",
      ).bind(notepadId, targetUserId, now + 60_000),
    ]);
    let intercepted = false;
    const racingDb = new Proxy(env.DB, {
      get(target, property, receiver) {
        if (property === 'batch')
          return async (statements: D1PreparedStatement[]) => {
            intercepted = true;
            await env.DB.prepare(
              "UPDATE members SET role = 'viewer' WHERE workspace_id = ? AND user_id = ?",
            )
              .bind(workspaceId, actorUserId)
              .run();
            try {
              return await target.batch(statements);
            } catch (error) {
              // A diagnostic reread seeing permission restored cannot turn an aborted command into success.
              await env.DB.prepare(
                "UPDATE members SET role = 'owner' WHERE workspace_id = ? AND user_id = ?",
              )
                .bind(workspaceId, actorUserId)
                .run();
              throw error;
            }
          };
        const value = Reflect.get(target, property, receiver);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
    const repository = createMemberRepository(createD1Db(racingDb));
    await expect(repository.remove({ workspaceId, actorUserId, targetUserId })).rejects.toThrow(
      'forbidden',
    );
    expect(intercepted).toBe(true);
    expect(await repository.findByUserId(workspaceId, targetUserId)).toMatchObject({
      role: 'editor',
    });
    expect(
      await env.DB.prepare('SELECT user_id FROM edit_locks WHERE notepad_id = ?')
        .bind(notepadId)
        .first(),
    ).toEqual({ user_id: targetUserId });
  });
});

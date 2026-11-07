import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { createDb } from '../../src/core/adapters/db/d1/client';
import { createCardRepository } from '../../src/core/adapters/db/d1/repositories/card';
import { createD1Infrastructure } from '../../src/core/adapters/db/d1';
import { CardService } from '../../src/core/services/cards';
import type { CardPlan } from '../../src/core/infrastructure/types';
import { expectInvariantsHold } from '../api/helpers';

const repository = createCardRepository(createDb(env.DB));
const id = () => crypto.randomUUID();

async function creationPlan(): Promise<CardPlan> {
  const plan: CardPlan = {
    workspaceId: id(),
    projectId: id(),
    boardId: id(),
    columnId: id(),
    actorId: id(),
    cardId: id(),
    notepadId: id(),
    title: 'Atomic card',
    content: '[]',
    plainText: '',
    priority: null,
    dueDate: null,
    assigneeIds: [],
    tagIds: [],
    assignmentNotifications: [],
    cardPosition: 'a0',
    linkedNotepad: null,
    now: Date.now(),
  };
  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO user (id, name, email, emailVerified, createdAt, updatedAt) VALUES (?, 'Actor', ? || '@test.com', 0, ?, ?)`,
    ).bind(plan.actorId, plan.actorId, plan.now, plan.now),
    env.DB.prepare(
      `INSERT INTO workspaces (id, name, created_by, created_at) VALUES (?, 'Cards', ?, ?)`,
    ).bind(plan.workspaceId, plan.actorId, plan.now),
    env.DB.prepare(
      `INSERT INTO projects (id, workspace_id, name, position, created_at, updated_at) VALUES (?, ?, 'Cards', 'a0', ?, ?)`,
    ).bind(plan.projectId, plan.workspaceId, plan.now, plan.now),
    env.DB.prepare(
      `INSERT INTO boards (id, workspace_id, project_id, name, position, created_at, updated_at) VALUES (?, ?, ?, 'Board', 'a0', ?, ?)`,
    ).bind(plan.boardId, plan.workspaceId, plan.projectId, plan.now, plan.now),
    env.DB.prepare(
      `INSERT INTO board_columns (id, board_id, name, position) VALUES (?, ?, 'Todo', 'a0')`,
    ).bind(plan.columnId, plan.boardId),
    env.DB.prepare(
      `INSERT INTO members (workspace_id, user_id, role, joined_at) VALUES (?, ?, 'owner', ?)`,
    ).bind(plan.workspaceId, plan.actorId, plan.now),
  ]);
  return plan;
}

async function count(table: string, column: string, value: string): Promise<number> {
  const row = await env.DB.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE ${column} = ?`)
    .bind(value)
    .first<{ n: number }>();
  return row?.n ?? 0;
}

describe('Card creation repository contract', () => {
  it('does not notify the actor when assigning the new card to themselves', async () => {
    const plan = await creationPlan();
    const service = new CardService(createD1Infrastructure(createDb(env.DB), env).repositories);
    const created = await service.createCard({
      workspaceId: plan.workspaceId,
      projectId: plan.projectId,
      actorId: plan.actorId,
      boardId: plan.boardId,
      columnId: plan.columnId,
      title: 'Self-assigned card',
      assigneeIds: [plan.actorId, plan.actorId],
    });
    expect(await count('card_assignees', 'card_id', created.cardId)).toBe(1);
    expect(await count('notifications', 'card_id', created.cardId)).toBe(0);
    await expectInvariantsHold(env.DB);
  });

  it('commits a linked note, body, index, backlink, tags, assignments and notifications together', async () => {
    const plan = await creationPlan();
    const tagId = id();
    const recipient = id();
    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO user (id, name, email, emailVerified, createdAt, updatedAt) VALUES (?, 'Recipient', ? || '@test.com', 0, ?, ?)`,
      ).bind(recipient, recipient, plan.now, plan.now),
      env.DB.prepare(`INSERT INTO tags (id, project_id, name) VALUES (?, ?, 'Tag')`).bind(
        tagId,
        plan.projectId,
      ),
      env.DB.prepare(
        `INSERT INTO members (workspace_id, user_id, role, joined_at) VALUES (?, ?, 'editor', ?)`,
      ).bind(plan.workspaceId, recipient, plan.now),
    ]);
    plan.linkedNotepad = { id: id(), position: 'a0', title: 'Linked note', mode: 'new' };
    plan.content = JSON.stringify([
      { type: 'notepadLink', props: { notepadId: plan.linkedNotepad.id } },
    ]);
    plan.tagIds = [tagId];
    plan.assigneeIds = [recipient];
    plan.assignmentNotifications = [{ id: id(), userId: recipient }];
    await repository.createFromPlan(plan);
    expect(await count('cards', 'id', plan.cardId)).toBe(1);
    expect(await count('notepads', 'id', plan.linkedNotepad.id)).toBe(1);
    expect(await count('notepads_fts', 'notepad_id', plan.linkedNotepad.id)).toBe(1);
    expect(await count('notepads_fts', 'notepad_id', plan.notepadId)).toBe(1);
    expect(await count('notepad_links', 'source_id', plan.notepadId)).toBe(1);
    expect(await count('notepad_tags', 'notepad_id', plan.notepadId)).toBe(1);
    expect(await count('card_assignees', 'card_id', plan.cardId)).toBe(1);
    expect(await count('notifications', 'card_id', plan.cardId)).toBe(1);
    await expectInvariantsHold(env.DB);
  });

  it('links an existing note without recreating or overwriting it', async () => {
    const plan = await creationPlan();
    const existingId = id();
    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO notepads (id, workspace_id, project_id, title, position, created_by, created_at, updated_at) VALUES (?, ?, ?, 'Original', 'a0', ?, ?, ?)`,
      ).bind(existingId, plan.workspaceId, plan.projectId, plan.actorId, plan.now, plan.now),
      env.DB.prepare(
        `INSERT INTO notepads_fts (notepad_id, project_id, title, body) VALUES (?, ?, 'Original', '')`,
      ).bind(existingId, plan.projectId),
    ]);
    plan.linkedNotepad = {
      id: existingId,
      position: 'a0',
      title: 'Ignored replacement',
      mode: 'existing',
    };
    plan.content = JSON.stringify([{ type: 'notepadLink', props: { notepadId: existingId } }]);
    await repository.createFromPlan(plan);
    expect(
      await env.DB.prepare('SELECT title FROM notepads WHERE id = ?').bind(existingId).first(),
    ).toEqual({ title: 'Original' });
    expect(
      await env.DB.prepare('SELECT target_id FROM notepad_links WHERE source_id = ?')
        .bind(plan.notepadId)
        .first(),
    ).toEqual({ target_id: existingId });
    expect(await count('notepads_fts', 'notepad_id', existingId)).toBe(1);
    await expectInvariantsHold(env.DB);
  });

  it('rolls back the body, linked note, index, links and assignments on a late notification failure', async () => {
    const plan = await creationPlan();
    const notificationId = id();
    const tagId = id();
    await env.DB.prepare(`INSERT INTO tags (id, project_id, name) VALUES (?, ?, 'Doomed tag')`)
      .bind(tagId, plan.projectId)
      .run();
    plan.linkedNotepad = { id: id(), position: 'a0', title: 'Doomed linked note', mode: 'new' };
    plan.content = JSON.stringify([
      { type: 'notepadLink', props: { notepadId: plan.linkedNotepad.id } },
    ]);
    plan.assigneeIds = [plan.actorId];
    plan.tagIds = [tagId];
    plan.assignmentNotifications = [{ id: notificationId, userId: plan.actorId }];
    await env.DB.prepare(
      `INSERT INTO notifications (id, workspace_id, user_id, type, actor_id, created_at) VALUES (?, ?, ?, 'assigned', ?, ?)`,
    )
      .bind(notificationId, plan.workspaceId, plan.actorId, plan.actorId, plan.now)
      .run();
    await expect(repository.createFromPlan(plan)).rejects.toThrow(
      /UNIQUE constraint failed: notifications.id/,
    );
    expect(await count('cards', 'id', plan.cardId)).toBe(0);
    for (const notepadId of [plan.notepadId, plan.linkedNotepad.id]) {
      expect(await count('notepads', 'id', notepadId)).toBe(0);
      expect(await count('notepads_fts', 'notepad_id', notepadId)).toBe(0);
    }
    expect(await count('notepad_links', 'source_id', plan.notepadId)).toBe(0);
    expect(await count('card_assignees', 'card_id', plan.cardId)).toBe(0);
    expect(await count('notepad_tags', 'notepad_id', plan.notepadId)).toBe(0);
    expect(await count('notifications', 'card_id', plan.cardId)).toBe(0);
    await expectInvariantsHold(env.DB);
  });
});

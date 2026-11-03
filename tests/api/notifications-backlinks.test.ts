import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { createWorkerApp } from '../../src/worker/index';
import { expectInvariantsHold } from './helpers';
import { getAccountWorkspaceScope } from './account-scope';

const app = createWorkerApp(env);

describe('Phase 5C: Relationships, Notifications & Backlinks', () => {
  const bootstrapToken = env.BOOTSTRAP_TOKEN || 'test-bootstrap-token';
  let ownerCookie = '';
  let editorCookie = '';
  let ownerUserId = '';
  let editorUserId = '';
  let workspaceId = '';
  let projectId = '';

  let notepad1Id = '';
  let notepad2Id = '';
  let boardId = '';
  let columnId = '';
  let cardId = '';

  it('sets up workspace with owner and editor', async () => {
    // 1. Owner
    const ownerRes = await app.request(
      'http://localhost/api/auth/sign-up/email',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          email: 'notif-owner@example.com',
          password: 'password123',
          name: 'Notif Owner',
          bootstrapToken,
        }),
      },
      env,
    );
    expect(ownerRes.status).toBe(200);
    ownerCookie = ownerRes.headers.get('set-cookie')!;

    const ownerScope = await getAccountWorkspaceScope((path) =>
      app.request(`http://localhost${path}`, { headers: { Cookie: ownerCookie } }, env),
    );
    ownerUserId = ownerScope.userId;
    workspaceId = ownerScope.workspaceId;
    projectId = ownerScope.projectId;

    // 2. Editor
    const inviteRes = await app.request(
      `http://localhost/api/workspaces/${workspaceId}/invites`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Cookie: ownerCookie },
        body: JSON.stringify({ email: 'notif-editor@example.com', role: 'editor' }),
      },
      env,
    );
    const invite = (await inviteRes.json()) as { token: string };

    const editorSignup = await app.request(
      'http://localhost/api/auth/sign-up/email',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          email: 'notif-editor@example.com',
          password: 'password123',
          name: 'Notif Editor',
          inviteToken: invite.token,
        }),
      },
      env,
    );
    editorCookie = editorSignup.headers.get('set-cookie')!;

    const editorScope = await getAccountWorkspaceScope((path) =>
      app.request(`http://localhost${path}`, { headers: { Cookie: editorCookie } }, env),
    );
    editorUserId = editorScope.userId;

    // 3. Create notepads
    const np1Res = await app.request(
      `http://localhost/api/workspaces/${workspaceId}/projects/${projectId}/notepads`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Cookie: ownerCookie },
        body: JSON.stringify({ title: 'Notepad 1' }),
      },
      env,
    );
    notepad1Id = ((await np1Res.json()) as { id: string }).id;

    const np2Res = await app.request(
      `http://localhost/api/workspaces/${workspaceId}/projects/${projectId}/notepads`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Cookie: ownerCookie },
        body: JSON.stringify({ title: 'Notepad 2' }),
      },
      env,
    );
    notepad2Id = ((await np2Res.json()) as { id: string }).id;

    // 4. Create board & card
    const bRes = await app.request(
      `http://localhost/api/workspaces/${workspaceId}/projects/${projectId}/boards`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Cookie: ownerCookie },
        body: JSON.stringify({ name: 'Notif Board' }),
      },
      env,
    );
    boardId = ((await bRes.json()) as { id: string }).id;

    const bDetailRes = await app.request(
      `http://localhost/api/workspaces/${workspaceId}/projects/${projectId}/boards/${boardId}`,
      { headers: { Cookie: ownerCookie } },
      env,
    );
    columnId = ((await bDetailRes.json()) as { columns: Array<{ id: string }> }).columns[0]!.id;

    const cRes = await app.request(
      `http://localhost/api/workspaces/${workspaceId}/projects/${projectId}/columns/${columnId}/cards`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Cookie: ownerCookie },
        body: JSON.stringify({ title: 'Important Task' }),
      },
      env,
    );
    cardId = ((await cRes.json()) as { cardId: string }).cardId;

    await expectInvariantsHold(env.DB);
  }, 15_000);

  it('notifies user on mention exactly once and excludes self-mentions', async () => {
    // Owner mentions editor in Notepad 1
    const contentWithMention = JSON.stringify([
      {
        id: 'block-1',
        type: 'paragraph',
        props: {},
        content: [
          { type: 'text', text: 'Hey ' },
          {
            type: 'mention',
            props: { kind: 'user', id: editorUserId, label: 'Notif Editor' },
          },
          { type: 'text', text: ' check this out' },
          // Self-mention should NOT notify owner
          {
            type: 'mention',
            props: { kind: 'user', id: ownerUserId, label: 'Notif Owner' },
          },
        ],
        children: [],
      },
    ]);

    const saveRes = await app.request(
      `http://localhost/api/workspaces/${workspaceId}/projects/${projectId}/notepads/${notepad1Id}/content`,
      {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', Cookie: ownerCookie },
        body: JSON.stringify({ content: contentWithMention, baseVersion: 1 }),
      },
      env,
    );
    expect(saveRes.status).toBe(200);

    // Check editor's notifications
    const editorNotifsRes = await app.request(
      `http://localhost/api/workspaces/${workspaceId}/notifications?unread=1`,
      { headers: { Cookie: editorCookie } },
      env,
    );
    expect(editorNotifsRes.status).toBe(200);
    const editorNotifs = (await editorNotifsRes.json()) as Array<{
      type: string;
      actor: { name: string };
      notepadId: string;
    }>;
    expect(editorNotifs.length).toBe(1);
    expect(editorNotifs[0]?.type).toBe('mention');
    expect(editorNotifs[0]?.actor.name).toBe('Notif Owner');
    expect(editorNotifs[0]?.notepadId).toBe(notepad1Id);

    // Check owner has no notifications (no self-mention notification)
    const ownerNotifsRes = await app.request(
      `http://localhost/api/workspaces/${workspaceId}/notifications`,
      { headers: { Cookie: ownerCookie } },
      env,
    );
    const ownerNotifs = (await ownerNotifsRes.json()) as Array<unknown>;
    expect(ownerNotifs.length).toBe(0);

    // Editing again with the same mention does NOT re-notify
    const save2Res = await app.request(
      `http://localhost/api/workspaces/${workspaceId}/projects/${projectId}/notepads/${notepad1Id}/content`,
      {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', Cookie: ownerCookie },
        body: JSON.stringify({
          content: contentWithMention.replace('check this out', 'updated check this out'),
          baseVersion: 2,
        }),
      },
      env,
    );
    expect(save2Res.status).toBe(200);

    const recheckNotifs = await app.request(
      `http://localhost/api/workspaces/${workspaceId}/notifications`,
      { headers: { Cookie: editorCookie } },
      env,
    );
    const allNotifs = (await recheckNotifs.json()) as Array<unknown>;
    expect(allNotifs.length).toBe(1); // Still exactly 1 notification

    await expectInvariantsHold(env.DB);
  }, 15_000);

  it('notifies assignee on card assignment', async () => {
    // Assign card to editor
    const assignRes = await app.request(
      `http://localhost/api/workspaces/${workspaceId}/projects/${projectId}/cards/${cardId}`,
      {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', Cookie: ownerCookie },
        body: JSON.stringify({ assigneeIds: [editorUserId] }),
      },
      env,
    );
    expect(assignRes.status).toBe(200);

    // Editor should have an 'assigned' notification
    const editorNotifsRes = await app.request(
      `http://localhost/api/workspaces/${workspaceId}/notifications?unread=1`,
      { headers: { Cookie: editorCookie } },
      env,
    );
    const notifs = (await editorNotifsRes.json()) as Array<{ type: string; cardId: string }>;
    const assignedNotif = notifs.find((n) => n.type === 'assigned');
    expect(assignedNotif).toBeDefined();
    expect(assignedNotif?.cardId).toBe(cardId);

    // Marking notifications read
    const markReadRes = await app.request(
      `http://localhost/api/workspaces/${workspaceId}/notifications/read`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Cookie: editorCookie },
        body: JSON.stringify({}),
      },
      env,
    );
    expect(markReadRes.status).toBe(200);

    // Unread count should now be 0
    const unreadRes = await app.request(
      `http://localhost/api/workspaces/${workspaceId}/notifications?unread=1`,
      { headers: { Cookie: editorCookie } },
      env,
    );
    const unread = (await unreadRes.json()) as Array<unknown>;
    expect(unread.length).toBe(0);

    await expectInvariantsHold(env.DB);
  }, 15_000);

  it.each(['selected', 'all'])(
    'marks %s notifications read only for the current workspace and user',
    async (mode) => {
      const foreignWorkspace = crypto.randomUUID();
      await env.DB.prepare(
        'INSERT INTO workspaces (id, name, created_by, created_at) VALUES (?, ?, ?, ?)',
      )
        .bind(foreignWorkspace, 'Foreign workspace', ownerUserId, Date.now())
        .run();
      await env.DB.prepare(
        "INSERT INTO members (workspace_id, user_id, role, joined_at) VALUES (?, ?, 'owner', ?)",
      )
        .bind(foreignWorkspace, ownerUserId, Date.now())
        .run();
      const rows = [
        { id: crypto.randomUUID(), workspace: workspaceId, user: ownerUserId, readAt: null },
        { id: crypto.randomUUID(), workspace: foreignWorkspace, user: ownerUserId, readAt: null },
        { id: crypto.randomUUID(), workspace: workspaceId, user: editorUserId, readAt: null },
        { id: crypto.randomUUID(), workspace: workspaceId, user: ownerUserId, readAt: 123 },
      ];
      await env.DB.batch(
        rows.map((row) =>
          env.DB.prepare(
            "INSERT INTO notifications (id, workspace_id, user_id, type, actor_id, read_at, created_at) VALUES (?, ?, ?, 'mention', ?, ?, ?)",
          ).bind(
            row.id,
            row.workspace,
            row.user,
            row.workspace === foreignWorkspace ? ownerUserId : editorUserId,
            row.readAt,
            Date.now(),
          ),
        ),
      );
      const response = await app.request(
        `http://localhost/api/workspaces/${workspaceId}/notifications/read`,
        {
          method: 'POST',
          headers: { Cookie: ownerCookie, 'Content-Type': 'application/json' },
          body: JSON.stringify(mode === 'selected' ? { ids: rows.map((row) => row.id) } : {}),
        },
        env,
      );
      expect(response.status).toBe(200);
      for (const [index, row] of rows.entries()) {
        const saved = await env.DB.prepare('SELECT read_at FROM notifications WHERE id = ?')
          .bind(row.id)
          .first<{ read_at: number | null }>();
        if (index === 0) expect(saved?.read_at).toBeGreaterThan(123);
        else expect(saved?.read_at).toBe(row.readAt);
      }

      const workspaceAList = (await (
        await app.request(
          `http://localhost/api/workspaces/${workspaceId}/notifications`,
          { headers: { Cookie: ownerCookie } },
          env,
        )
      ).json()) as Array<{ id: string }>;
      const workspaceBList = (await (
        await app.request(
          `http://localhost/api/workspaces/${foreignWorkspace}/notifications`,
          { headers: { Cookie: ownerCookie } },
          env,
        )
      ).json()) as Array<{ id: string }>;
      expect(workspaceAList.some(({ id }) => id === rows[1]!.id)).toBe(false);
      expect(workspaceBList.some(({ id }) => id === rows[1]!.id)).toBe(true);
    },
  );

  it('indexes backlinks and removes deleted sources', async () => {
    // Notepad 2 links to Notepad 1
    const contentWithLink = JSON.stringify([
      {
        id: 'block-2',
        type: 'notepadLink',
        props: { notepadId: notepad1Id },
        content: [],
        children: [],
      },
    ]);

    const saveLinkRes = await app.request(
      `http://localhost/api/workspaces/${workspaceId}/projects/${projectId}/notepads/${notepad2Id}/content`,
      {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', Cookie: ownerCookie },
        body: JSON.stringify({ content: contentWithLink, baseVersion: 1 }),
      },
      env,
    );
    expect(saveLinkRes.status).toBe(200);

    // The scoped note detail returns backlinks: Notepad 1 should show Notepad 2.
    const np1Detail = await app.request(
      `http://localhost/api/workspaces/${workspaceId}/projects/${projectId}/notepads/${notepad1Id}`,
      { headers: { Cookie: ownerCookie } },
      env,
    );
    expect(np1Detail.status).toBe(200);
    const np1Data = (await np1Detail.json()) as {
      backlinks: Array<{ id: string; title: string }>;
    };
    expect(np1Data.backlinks.length).toBe(1);
    expect(np1Data.backlinks[0]?.id).toBe(notepad2Id);
    expect(np1Data.backlinks[0]?.title).toBe('Notepad 2');

    // Soft delete Notepad 2
    const delRes = await app.request(
      `http://localhost/api/workspaces/${workspaceId}/projects/${projectId}/notepads/${notepad2Id}`,
      { method: 'DELETE', headers: { Cookie: ownerCookie } },
      env,
    );
    expect(delRes.status).toBe(200);

    // Trashed source should disappear from backlinks
    const np1AfterDel = await app.request(
      `http://localhost/api/workspaces/${workspaceId}/projects/${projectId}/notepads/${notepad1Id}`,
      { headers: { Cookie: ownerCookie } },
      env,
    );
    const np1AfterDelData = (await np1AfterDel.json()) as {
      backlinks: Array<{ id: string }>;
    };
    expect(np1AfterDelData.backlinks.length).toBe(0);

    await expectInvariantsHold(env.DB);
  }, 15_000);

  it('keeps legacy document text but indexes only live project references and workspace member mentions', async () => {
    const headers = { Cookie: ownerCookie, 'Content-Type': 'application/json' };
    const projectResponse = await app.request(
      `http://localhost/api/workspaces/${workspaceId}/projects`,
      {
        method: 'POST',
        headers,
        body: JSON.stringify({ name: 'Other reference project' }),
      },
      env,
    );
    expect(projectResponse.status).toBe(201);
    const foreignProject = ((await projectResponse.json()) as { id: string }).id;
    async function createNote(project: string, title: string) {
      const response = await app.request(
        `http://localhost/api/workspaces/${workspaceId}/projects/${project}/notepads`,
        {
          method: 'POST',
          headers,
          body: JSON.stringify({ title }),
        },
        env,
      );
      expect(response.status).toBe(201);
      return ((await response.json()) as { id: string }).id;
    }
    const target = await createNote(projectId, 'Local target');
    const source = await createNote(projectId, 'Legacy reference source');
    const foreign = await createNote(foreignProject, 'Other project target');
    const deleted = await createNote(projectId, 'Deleted target');
    expect(
      (
        await app.request(
          `http://localhost/api/workspaces/${workspaceId}/projects/${projectId}/notepads/${deleted}`,
          { method: 'DELETE', headers },
          env,
        )
      ).status,
    ).toBe(200);
    const foreignWorkspace = crypto.randomUUID(),
      foreignProjectId = crypto.randomUUID(),
      foreignNote = crypto.randomUUID();
    const now = Date.now();
    await env.DB.batch([
      env.DB.prepare(
        'INSERT INTO workspaces (id, name, created_by, created_at) VALUES (?, ?, ?, ?)',
      ).bind(foreignWorkspace, 'Foreign workspace', ownerUserId, now),
      env.DB.prepare(
        'INSERT INTO projects (id, workspace_id, name, position, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)',
      ).bind(foreignProjectId, foreignWorkspace, 'Foreign project', 'a0', now, now),
      env.DB.prepare(
        'INSERT INTO notepads (id, workspace_id, project_id, title, position, created_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      ).bind(
        foreignNote,
        foreignWorkspace,
        foreignProjectId,
        'Foreign note',
        'a0',
        ownerUserId,
        now,
        now,
      ),
      env.DB.prepare(
        'INSERT INTO notepads_fts (notepad_id, project_id, title, body) VALUES (?, ?, ?, ?)',
      ).bind(foreignNote, foreignProjectId, 'Foreign note', ''),
    ]);
    // Simulate a legacy cross-project edge so read paths prove they filter corrupt rows.
    // Current writes reject this row, so briefly bypass only the scope guard and restore it.
    await env.DB.prepare('DROP TRIGGER notepad_links_scope_insert_guard').run();
    try {
      await env.DB.prepare(
        'INSERT INTO notepad_links (source_id, target_type, target_id) VALUES (?, ?, ?)',
      )
        .bind(foreign, 'notepad', target)
        .run();
    } finally {
      await env.DB.prepare(`
        CREATE TRIGGER notepad_links_scope_insert_guard
        BEFORE INSERT ON notepad_links
        WHEN NEW.target_type IN ('notepad', 'card', 'board') AND NOT EXISTS (
          SELECT 1 FROM notepads source
          WHERE source.id = NEW.source_id AND (
            (NEW.target_type = 'notepad' AND EXISTS (
              SELECT 1 FROM notepads target WHERE target.id = NEW.target_id
                AND target.project_id = source.project_id AND target.workspace_id = source.workspace_id
            )) OR (NEW.target_type = 'card' AND EXISTS (
              SELECT 1 FROM cards c JOIN boards b ON b.id = c.board_id
              JOIN projects p ON p.id = b.project_id
              JOIN notepads body ON body.id = c.notepad_id
              WHERE c.id = NEW.target_id AND p.id = source.project_id
                AND b.workspace_id = source.workspace_id AND body.kind = 'card'
                AND body.project_id = p.id AND body.workspace_id = p.workspace_id
            )) OR (NEW.target_type = 'board' AND EXISTS (
              SELECT 1 FROM boards b JOIN projects p ON p.id = b.project_id
              WHERE b.id = NEW.target_id AND p.id = source.project_id
                AND b.workspace_id = source.workspace_id
            ))
          )
        )
        BEGIN SELECT RAISE(ABORT, 'scope_write_conflict'); END
      `).run();
    }
    const missingMember = crypto.randomUUID();
    const content = JSON.stringify([
      ...[target, foreign, foreignNote, deleted].map((id) => ({
        type: 'notepadLink',
        props: { notepadId: id },
      })),
      {
        type: 'paragraph',
        content: [
          { type: 'mention', props: { kind: 'user', id: editorUserId, label: 'Current member' } },
          {
            type: 'mention',
            props: { kind: 'user', id: missingMember, label: 'Legacy mention text' },
          },
        ],
      },
    ]);
    const save = await app.request(
      `http://localhost/api/workspaces/${workspaceId}/projects/${projectId}/notepads/${source}/content`,
      {
        method: 'PUT',
        headers,
        body: JSON.stringify({ content, baseVersion: 1 }),
      },
      env,
    );
    expect(save.status).toBe(200);
    const saved = await app.request(`http://localhost/api/workspaces/${workspaceId}/projects/${projectId}/notepads/${source}`, { headers }, env);
    expect(((await saved.json()) as { content: string }).content).toBe(content);
    const storedLinks = await env.DB.prepare(
      'SELECT target_type, target_id FROM notepad_links WHERE source_id = ? ORDER BY target_type',
    )
      .bind(source)
      .all();
    expect(storedLinks.results).toEqual([
      { target_type: 'notepad', target_id: target },
      { target_type: 'user', target_id: editorUserId },
    ]);
    const notifications = await env.DB.prepare(
      'SELECT user_id FROM notifications WHERE notepad_id = ?',
    )
      .bind(source)
      .all();
    expect(notifications.results).toEqual([{ user_id: editorUserId }]);
    const backlinks = await app.request(
      `http://localhost/api/workspaces/${workspaceId}/projects/${projectId}/notepads/${target}`,
      { headers },
      env,
    );
    expect(
      ((await backlinks.json()) as { backlinks: Array<{ id: string }> }).backlinks.map(
        ({ id }) => id,
      ),
    ).toEqual([source]);
    const foreignTarget = await app.request(
      `http://localhost/api/workspaces/${workspaceId}/projects/${foreignProject}/notepads/${foreign}`,
      { headers },
      env,
    );
    expect(((await foreignTarget.json()) as { backlinks: unknown[] }).backlinks).toEqual([]);
    expect(
      (
        await app.request(
          `http://localhost/api/workspaces/${workspaceId}/projects/${projectId}/notepads/${target}`,
          { method: 'DELETE', headers },
          env,
        )
      ).status,
    ).toBe(200);
    const deletedTarget = await app.request(
      `http://localhost/api/workspaces/${workspaceId}/projects/${projectId}/notepads/${target}`,
      { headers },
      env,
    );
    expect(((await deletedTarget.json()) as { backlinks: unknown[] }).backlinks).toEqual([]);
    await env.DB.prepare(
      'DELETE FROM notepad_links WHERE source_id = ? AND target_type = ? AND target_id = ?',
    )
      .bind(foreign, 'notepad', target)
      .run();
    await expectInvariantsHold(env.DB);
  });
});

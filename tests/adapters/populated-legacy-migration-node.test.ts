import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import postgres from 'postgres';
import { expect, inject, it } from 'vitest';
import { splitSqlStatements } from '../../src/server/sql-statements';
import { applyPostgresMigrations } from '../../src/core/adapters/db/postgres';

it('upgrades populated legacy PostgreSQL data without relocating corrupt scope rows', async () => {
  const adminUrl = inject('postgresTestUrl');
  const admin = postgres(adminUrl, { max: 1, onnotice: () => {} });
  const database = `legacy_upgrade_${randomUUID().replaceAll('-', '')}`;
  let client: ReturnType<typeof postgres> | undefined;

  try {
    await admin.unsafe(`CREATE DATABASE "${database}"`);
    const databaseUrl = new URL(adminUrl);
    databaseUrl.pathname = `/${database}`;
    client = postgres(databaseUrl.toString(), { max: 2, onnotice: () => {} });

    // This is the last deployed PostgreSQL baseline before the pending upgrade.
    await client.unsafe(readFileSync(join(process.cwd(), 'migrations/postgres/0000_puzzling_longshot.sql'), 'utf8'));
    await client`CREATE TABLE _migrations (filename text PRIMARY KEY, applied_at bigint NOT NULL)`;
    await client`INSERT INTO _migrations (filename, applied_at) VALUES ('0000_puzzling_longshot.sql', 1)`;

    const now = new Date('2026-01-02T03:04:05.000Z');
    const userId = 'legacy-owner';
    const workspaceA = 'legacy-workspace-a';
    const workspaceB = 'legacy-workspace-b';
    const projectA = 'legacy-project-a';
    const projectB = 'legacy-project-b';
    const projectA2 = 'legacy-project-a2';
    const noteA = 'legacy-note-a';
    const noteShared = 'legacy-note-shared-cover';
    const cardBody = 'legacy-card-body';
    const corruptNote = 'legacy-corrupt-note';
    const boardA = 'legacy-board-a';
    const corruptBoard = 'legacy-corrupt-board';
    const columnA = 'legacy-column-a';
    const cardA = 'legacy-card-a';
    const tagA = 'legacy-tag-a';

    await client`
      INSERT INTO "user" (id, name, email, email_verified, created_at, updated_at)
      VALUES (${userId}, 'Legacy Owner', 'legacy@example.com', true, ${now}, ${now})`;
    await client`
      INSERT INTO workspaces (id, name, created_by, created_at)
      VALUES (${workspaceA}, 'Legacy A', ${userId}, 10), (${workspaceB}, 'Legacy B', ${userId}, 11)`;
    await client`
      INSERT INTO members (workspace_id, user_id, role, joined_at)
      VALUES (${workspaceA}, ${userId}, 'owner', 12)`;
    await client`
      INSERT INTO projects (id, workspace_id, name, position, created_at, updated_at)
      VALUES (${projectA}, ${workspaceA}, 'Project A', 'a0', 13, 13),
             (${projectB}, ${workspaceB}, 'Project B', 'a0', 14, 14),
             (${projectA2}, ${workspaceA}, 'Project A2', 'a1', 15, 15)`;
    await client`
      INSERT INTO notepads
        (id, workspace_id, project_id, kind, title, cover_key, content, version, position, is_favorite,
         created_by, created_at, updated_at, plain_text)
      VALUES (${noteA}, ${workspaceA}, ${projectA}, 'notepad', 'Legacy note', ${`${workspaceA}/shared.png`}, '[]', 3, 'a0', true,
              ${userId}, 15, 16, 'kept note body'),
             (${cardBody}, ${workspaceA}, ${projectA}, 'card', 'Legacy card', ${`${workspaceA}/legacy.bin`}, '[]', 2, 'a1', false,
              ${userId}, 17, 18, 'kept card body'),
             (${corruptNote}, ${workspaceB}, ${projectA}, 'notepad', 'Corrupt legacy note', ${`${workspaceB}/foreign.jpg`}, '[]', 1, 'a2', false,
              ${userId}, 19, 20, 'keep corrupt scope as-is'),
             (${noteShared}, ${workspaceA}, ${projectA2}, 'notepad', 'Shared legacy cover', ${`${workspaceA}/shared.png`}, '[]', 1, 'a0', false,
              ${userId}, 24, 24, 'shared cover across projects')`;
    await client`
      INSERT INTO boards (id, workspace_id, project_id, name, position, created_at, updated_at)
      VALUES (${boardA}, ${workspaceA}, ${projectA}, 'Legacy board', 'a0', 21, 22),
             (${corruptBoard}, ${workspaceB}, ${projectA}, 'Corrupt legacy board', 'a1', 23, 24)`;
    await client`
      INSERT INTO board_columns (id, board_id, name, position)
      VALUES (${columnA}, ${boardA}, 'To do', 'a0')`;
    await client`
      INSERT INTO cards (id, board_id, column_id, notepad_id, position, created_at)
      VALUES (${cardA}, ${boardA}, ${columnA}, ${cardBody}, 'a0', 25)`;
    await client`
      INSERT INTO tags (id, project_id, name, color)
      VALUES (${tagA}, ${projectA}, 'Legacy tag', '#123456')`;
    await client`
      INSERT INTO notepad_tags (notepad_id, tag_id) VALUES (${noteA}, ${tagA})`;
    await client`
      INSERT INTO notepad_links (source_id, target_type, target_id)
      VALUES (${noteA}, 'card', ${cardA})`;

    await applyPostgresMigrations(client);

    expect(
      Array.from(
        await client`
          SELECT
            (SELECT count(*) FROM workspaces) AS workspaces,
            (SELECT count(*) FROM projects) AS projects,
            (SELECT count(*) FROM notepads) AS notepads,
            (SELECT count(*) FROM boards) AS boards,
            (SELECT count(*) FROM board_columns) AS board_columns,
            (SELECT count(*) FROM cards) AS cards,
            (SELECT count(*) FROM tags) AS tags,
            (SELECT count(*) FROM notepad_tags) AS notepad_tags,
            (SELECT count(*) FROM notepad_links) AS notepad_links`,
      ),
    ).toEqual([
      {
        workspaces: 2,
        projects: 3,
        notepads: 4,
        boards: 2,
        board_columns: 1,
        cards: 1,
        tags: 1,
        notepad_tags: 1,
        notepad_links: 1,
      },
    ]);
    expect(
      Array.from(await client`SELECT id, workspace_id, project_id, title, version, is_favorite, plain_text FROM notepads WHERE id = ${noteA}`),
    ).toEqual([
      {
        id: noteA,
        workspace_id: workspaceA,
        project_id: projectA,
        title: 'Legacy note',
        version: 3,
        is_favorite: true,
        plain_text: 'kept note body',
      },
    ]);
    expect(
      Array.from(await client`SELECT id, board_id, column_id, notepad_id FROM cards WHERE id = ${cardA}`),
    ).toEqual([{ id: cardA, board_id: boardA, column_id: columnA, notepad_id: cardBody }]);
    expect(
      Array.from(await client`SELECT notepad_id, tag_id FROM notepad_tags WHERE notepad_id = ${noteA}`),
    ).toEqual([{ notepad_id: noteA, tag_id: tagA }]);
    expect(
      Array.from(await client`SELECT source_id, target_type, target_id FROM notepad_links WHERE source_id = ${noteA}`),
    ).toEqual([{ source_id: noteA, target_type: 'card', target_id: cardA }]);

    // The upgrade preserves corrupt data and leaves a queryable report instead of
    // silently rewriting its workspace to match the project.
    const scopeViolations = await client`
      SELECT 'notepad' AS entity, n.id, n.workspace_id, p.workspace_id AS project_workspace_id
      FROM notepads n JOIN projects p ON p.id = n.project_id
      WHERE n.workspace_id <> p.workspace_id
      UNION ALL
      SELECT 'board' AS entity, b.id, b.workspace_id, p.workspace_id AS project_workspace_id
      FROM boards b JOIN projects p ON p.id = b.project_id
      WHERE b.workspace_id <> p.workspace_id
      ORDER BY entity, id`;
    expect(Array.from(scopeViolations)).toEqual([
      {
        entity: 'board',
        id: corruptBoard,
        workspace_id: workspaceB,
        project_workspace_id: workspaceA,
      },
      {
        entity: 'notepad',
        id: corruptNote,
        workspace_id: workspaceB,
        project_workspace_id: workspaceA,
      },
    ]);
    expect(
      Array.from(await client`SELECT workspace_id FROM notepads WHERE id = ${corruptNote}`),
    ).toEqual([{ workspace_id: workspaceB }]);
    expect(
      Array.from(await client`SELECT status FROM bootstrap_state WHERE id = 1`),
    ).toEqual([{ status: 'complete' }]);

    expect(
      Array.from(
        await client`SELECT project_id, storage_key, content_type, created_by, created_at
          FROM project_files WHERE storage_key = ${`${workspaceA}/shared.png`}
          ORDER BY project_id`,
      ),
    ).toEqual([
      {
        project_id: projectA,
        storage_key: `${workspaceA}/shared.png`,
        content_type: 'image/png',
        created_by: userId,
        created_at: 15,
      },
      {
        project_id: projectA2,
        storage_key: `${workspaceA}/shared.png`,
        content_type: 'image/png',
        created_by: userId,
        created_at: 24,
      },
    ]);
    expect(
      Array.from(await client`SELECT cover_key FROM notepads WHERE id = ${noteA}`),
    ).toEqual([{ cover_key: `${workspaceA}/shared.png` }]);
    expect(
      Array.from(await client`SELECT cover_key FROM notepads WHERE id = ${corruptNote}`),
    ).toEqual([{ cover_key: `${workspaceB}/foreign.jpg` }]);
    expect(
      Array.from(await client`SELECT project_id FROM project_files WHERE storage_key = ${`${workspaceB}/foreign.jpg`}`),
    ).toHaveLength(0);
    const invariantSql = readFileSync(
      join(process.cwd(), 'scripts/check-invariants.postgres.sql'),
      'utf8',
    );
    const violations = [];
    for (const statement of splitSqlStatements(invariantSql)) {
      violations.push(...(await client.unsafe(statement)));
    }
    expect(violations).toEqual([
      {
        invariant: 'I3',
        subject: corruptBoard,
        detail: 'board workspace != project workspace',
      },
      {
        invariant: 'I4',
        subject: corruptNote,
        detail: 'notepad workspace != project workspace',
      },
      {
        invariant: 'I13',
        subject: corruptNote,
        detail: 'cover notepad workspace != project workspace',
      },
    ]);

    await applyPostgresMigrations(client);
    expect(await client`SELECT id FROM bootstrap_state`).toHaveLength(1);
    expect(await client`SELECT id FROM notepads WHERE id = ${noteA}`).toHaveLength(1);
  } finally {
    await client?.end();
    await admin.unsafe(`DROP DATABASE IF EXISTS "${database}" WITH (FORCE)`);
    await admin.end();
  }
});

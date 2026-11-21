import { describe, it, expect } from 'vitest';
import { zipSync, unzipSync, strToU8 } from 'fflate';
import { analyzeImportZip, stripNotionUuid } from './notionImporter';
import {
  buildMultiWorkspaceExportZip,
  type WorkspaceExportManifest,
} from './markdownPortability';
import { serializeCsv } from '../../shared/csv';

describe('Notion ZIP Importer & Backup Analyzer (Milestone 3)', () => {
  it('strips 32-hex Notion UUID suffixes cleanly', () => {
    expect(stripNotionUuid('Engineering Roadmap 9a8b7c6d5e4f3a2b1c0d9e8f7a6b5c4d')).toBe(
      'Engineering Roadmap',
    );
    expect(stripNotionUuid('Plain Title')).toBe('Plain Title');
  });

  it('pairs Notion CSV databases with companion markdown card bodies and builds nested notepad tree', () => {
    const csv = serializeCsv(
      ['Name', 'Status', 'Priority', 'Tags'],
      [
        ['Build Export', 'In Progress', 'High', 'portability, backend'],
        ['Ship Importer', 'Done', 'Urgent', 'notion'],
      ],
    );
    const zipBytes = zipSync({
      'Team Wiki 11112222333344445555666677778888.md': strToU8('# Team Wiki\n\nWelcome!'),
      'Team Wiki 11112222333344445555666677778888/Architecture 22223333444455556666777788889999.md':
        strToU8('# Architecture\n\nDetails here.'),
      'Sprint Board aaaabbbbccccddddeeeeffff00001111.csv': strToU8(csv),
      'Sprint Board aaaabbbbccccddddeeeeffff00001111/Build Export 33334444555566667777888899990000.md':
        strToU8('# Build Export\n\nCard body content'),
      'Sprint Board aaaabbbbccccddddeeeeffff00001111/logo.png': new Uint8Array([137, 80, 78, 71]),
    });

    const result = analyzeImportZip(zipBytes);
    expect(result.kind).toBe('notion-zip');
    expect(result.notepadsCount).toBe(2);
    expect(result.boardsCount).toBe(1);
    expect(result.cardsCount).toBe(2);
    expect(result.mediaCount).toBe(1);

    const [rootNote, childNote] = result.notionData!.notepads;
    expect(rootNote!.title).toBe('Team Wiki');
    expect(rootNote!.parentTempId).toBeNull();
    expect(childNote!.title).toBe('Architecture');
    expect(childNote!.parentTempId).toBe(rootNote!.tempId);

    const board = result.notionData!.boards[0]!;
    expect(board.name).toBe('Sprint Board');
    expect(board.columns.map((c) => c.name)).toEqual(['In Progress', 'Done']);
    expect(board.cards[0]!.markdown).toContain('Card body content');
    expect(board.cards[0]!.priority).toBe('high');
    expect(board.cards[0]!.tagNames).toEqual(['portability', 'backend']);
  });

  it('packages and analyzes multi-workspace export backups with aggregated counts', async () => {
    const makeManifest = (id: string, name: string, noteTitle: string): WorkspaceExportManifest => ({
      schemaVersion: 'burrow-export-v1',
      exportedAt: 1700000000000,
      workspace: { id, name },
      projects: [
        {
          id: `proj_${id}`,
          name: 'Core',
          icon: null,
          color: null,
          tags: [{ id: `tag_${id}`, name: 'v1', color: '#6366f1' }],
          notepads: [
            {
              id: `np_${id}`,
              parentId: null,
              title: noteTitle,
              icon: null,
              coverKey: null,
              position: 'a0',
              isFavorite: false,
              content: '[]',
              tagIds: [`tag_${id}`],
              createdAt: 1700000000000,
              updatedAt: 1700000000000,
            },
          ],
          boards: [
            {
              id: `b_${id}`,
              name: 'Roadmap',
              icon: null,
              columns: [
                {
                  id: `col_${id}`,
                  name: 'Todo',
                  color: null,
                  wipLimit: null,
                  cards: [
                    {
                      id: `c_${id}`,
                      columnId: `col_${id}`,
                      notepadId: `np_${id}`,
                      title: 'Task 1',
                      priority: 'medium',
                      dueDate: null,
                      createdAt: 1700000000000,
                      assignees: [],
                      tags: [],
                      content: '[]',
                      subtasks: [],
                    },
                  ],
                },
              ],
            },
          ],
          files: [],
        },
      ],
    });

    const zipBytes = await buildMultiWorkspaceExportZip(
      [makeManifest('ws_1', 'Alpha', 'Alpha Note'), makeManifest('ws_2', 'Alpha', 'Beta Note')],
      { includeMedia: false },
    );

    const unzipped = unzipSync(zipBytes);
    const entries = Object.keys(unzipped);
    expect(entries).toContain('burrow-multi-workspace-backup.json');
    expect(entries.some((e) => e.startsWith('workspaces/Alpha/'))).toBe(true);
    expect(entries.some((e) => e.startsWith('workspaces/Alpha-ws_2/'))).toBe(true);

    const analyzed = analyzeImportZip(zipBytes);
    expect(analyzed.kind).toBe('burrow-backup');
    expect(analyzed.notepadsCount).toBe(2);
    expect(analyzed.boardsCount).toBe(2);
    expect(analyzed.cardsCount).toBe(2);
    expect(analyzed.burrowManifests).toHaveLength(2);
    expect(analyzed.burrowManifests?.[0]?.workspace.id).toBe('ws_1');
    expect(analyzed.burrowManifests?.[1]?.workspace.id).toBe('ws_2');
  });
});

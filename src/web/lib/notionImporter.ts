import { BlockNoteEditor } from '@blocknote/core';
import { unzipSync, strFromU8 } from 'fflate';
import * as chrono from 'chrono-node';
import { parseCsv } from '../../shared/csv';
import { MAX_NOTEPAD_DEPTH } from '../../core/shared/limits';
import type {
  MultiWorkspaceExportManifest,
  WorkspaceExportManifest,
} from './markdownPortability';

export interface AnalyzedNotepad {
  tempId: string;
  parentTempId: string | null;
  title: string;
  markdown: string;
  depth: number;
}

export interface AnalyzedCard {
  title: string;
  columnName: string;
  priority: 'low' | 'medium' | 'high' | 'urgent' | null;
  dueDate: number | null;
  tagNames: string[];
  markdown: string;
}

export interface AnalyzedBoard {
  name: string;
  columns: Array<{ name: string }>;
  cards: AnalyzedCard[];
}

export interface ImportArchiveAnalysis {
  kind: 'burrow-backup' | 'notion-zip';
  workspaceName: string;
  notepadsCount: number;
  boardsCount: number;
  cardsCount: number;
  mediaCount: number;
  limitations: string[];
  burrowManifest?: WorkspaceExportManifest;
  burrowManifests?: WorkspaceExportManifest[];
  notionData?: {
    notepads: AnalyzedNotepad[];
    boards: AnalyzedBoard[];
    mediaEntries: Array<{ archivePath: string; filename: string; bytes: Uint8Array }>;
  };
}

const NOTION_UUID_SUFFIX_RE = /\s+[0-9a-f]{32}$/i;

export function stripNotionUuid(name: string): string {
  return name.replace(NOTION_UUID_SUFFIX_RE, '').trim();
}

function normalizePath(path: string): string {
  return path.replace(/\\/g, '/').replace(/^\/+/, '').replace(/\/+$/, '');
}

function removeFileExtension(filename: string): string {
  const idx = filename.lastIndexOf('.');
  return idx > 0 ? filename.slice(0, idx) : filename;
}

function inferPriority(raw: string | undefined): 'low' | 'medium' | 'high' | 'urgent' | null {
  if (!raw) return null;
  const v = raw.trim().toLowerCase();
  if (v === 'urgent' || v === 'critical' || v === 'p0') return 'urgent';
  if (v === 'high' || v === 'p1') return 'high';
  if (v === 'medium' || v === 'normal' || v === 'p2') return 'medium';
  if (v === 'low' || v === 'p3') return 'low';
  return null;
}

function inferDueDate(raw: string | undefined): number | null {
  if (!raw || !raw.trim()) return null;
  const parsed = chrono.parseDate(raw.trim());
  return parsed ? parsed.getTime() : null;
}

function pickField(row: Record<string, string>, candidates: string[]): string | undefined {
  const entries = Object.entries(row);
  for (const cand of candidates) {
    const found = entries.find(([k]) => k.toLowerCase() === cand.toLowerCase());
    if (found && found[1]) return found[1];
  }
  return undefined;
}

export function analyzeImportZip(zipBytes: Uint8Array): ImportArchiveAnalysis {
  const unzipped = unzipSync(zipBytes);
  const paths = Object.keys(unzipped).map(normalizePath).filter(Boolean);

  // 1. Check for Multi-Workspace Lossless Burrow Backup
  const multiBackupKey = paths.find(
    (p) =>
      p === 'burrow-multi-workspace-backup.json' ||
      p.endsWith('/burrow-multi-workspace-backup.json'),
  );
  if (multiBackupKey) {
    const multiManifest = JSON.parse(
      strFromU8(unzipped[multiBackupKey]!),
    ) as MultiWorkspaceExportManifest;
    const workspaces = Array.isArray(multiManifest.workspaces) ? multiManifest.workspaces : [];
    const aggregateCounts = (wsList: WorkspaceExportManifest[]) =>
      wsList.reduce(
        (acc, ws) => {
          for (const p of ws.projects) {
            acc.notepadsCount += p.notepads.length;
            acc.boardsCount += p.boards.length;
            acc.cardsCount += p.boards.reduce(
              (bs, b) => bs + b.columns.reduce((cs, c) => cs + c.cards.length, 0),
              0,
            );
            acc.mediaCount += p.files.length;
          }
          return acc;
        },
        { notepadsCount: 0, boardsCount: 0, cardsCount: 0, mediaCount: 0 },
      );
    const counts = aggregateCounts(workspaces);
    return {
      kind: 'burrow-backup',
      workspaceName: `${workspaces.length} Workspaces (${workspaces.map((w) => w.workspace.name).join(', ')})`,
      ...counts,
      limitations: [
        `Contains ${workspaces.length} workspace backups. Migrating creates a fresh imported workspace for each backup while preserving all BlockNote blocks, hierarchy, boards, cards, and subtasks.`,
      ],
      burrowManifest: workspaces[0],
      burrowManifests: workspaces,
    };
  }

  // 2. Check for Single-Workspace Lossless Burrow Backup
  const backupKey = paths.find((p) => p === 'burrow-backup.json' || p.endsWith('/burrow-backup.json'));
  if (backupKey) {
    const manifest = JSON.parse(strFromU8(unzipped[backupKey]!)) as WorkspaceExportManifest;
    const notepadsCount = manifest.projects.reduce((sum, p) => sum + p.notepads.length, 0);
    const boardsCount = manifest.projects.reduce((sum, p) => sum + p.boards.length, 0);
    const cardsCount = manifest.projects.reduce(
      (sum, p) =>
        sum + p.boards.reduce((bs, b) => bs + b.columns.reduce((cs, c) => cs + c.cards.length, 0), 0),
      0,
    );
    const mediaCount = manifest.projects.reduce((sum, p) => sum + p.files.length, 0);
    return {
      kind: 'burrow-backup',
      workspaceName: manifest.workspace.name,
      notepadsCount,
      boardsCount,
      cardsCount,
      mediaCount,
      limitations: [
        'Original internal IDs are cleanly remapped to fresh IDs while preserving all BlockNote blocks, hierarchy, boards, cards, and subtasks.',
      ],
      burrowManifest: manifest,
      burrowManifests: [manifest],
    };
  }

  // 2. Parse Notion Markdown + CSV Export ZIP
  const csvFiles = paths.filter((p) => p.toLowerCase().endsWith('.csv'));
  const mdFiles = paths.filter((p) => p.toLowerCase().endsWith('.md'));
  const mediaFiles = paths.filter((p) => {
    const lower = p.toLowerCase();
    return (
      !lower.endsWith('.md') &&
      !lower.endsWith('.csv') &&
      !lower.endsWith('.json') &&
      !lower.endsWith('/') &&
      !p.startsWith('__MACOSX')
    );
  });

  // Identify companion folders for CSV databases (<dir>/<name>.csv <-> <dir>/<name>/*.md)
  const databaseFolders = new Set<string>();
  const boards: AnalyzedBoard[] = [];

  for (const csvPath of csvFiles) {
    const csvNoExt = removeFileExtension(csvPath);
    const companionFolderPrefix = `${csvNoExt}/`;
    const hasCompanion = mdFiles.some((m) => m.startsWith(companionFolderPrefix));
    if (hasCompanion) {
      databaseFolders.add(csvNoExt);
    }

    const csvText = strFromU8(unzipped[csvPath]!);
    const parsed = parseCsv(csvText);
    const rawBoardName = csvNoExt.split('/').pop() ?? 'Imported Board';
    const boardName = stripNotionUuid(rawBoardName) || 'Imported Board';

    const colNames = new Set<string>();
    const cards: AnalyzedCard[] = [];

    for (const row of parsed.rows) {
      const title =
        pickField(row, ['Name', 'Title', 'Task', 'Card']) || Object.values(row)[0] || 'Untitled Card';
      const status = pickField(row, ['Status', 'Stage', 'Column', 'State']) || 'To Do';
      colNames.add(status);
      const priority = inferPriority(pickField(row, ['Priority', 'Urgency']));
      const dueDate = inferDueDate(pickField(row, ['Due Date', 'Due', 'Date']));
      const rawTags = pickField(row, ['Tags', 'Tag', 'Labels', 'Category']);
      const tagNames = rawTags
        ? rawTags
            .split(',')
            .map((t) => t.trim())
            .filter(Boolean)
        : [];

      // Match companion markdown body file
      let cardMarkdown = '';
      if (hasCompanion) {
        const matchMd = mdFiles.find((m) => {
          if (!m.startsWith(companionFolderPrefix)) return false;
          const fileBase = stripNotionUuid(removeFileExtension(m.slice(companionFolderPrefix.length)));
          return fileBase.toLowerCase() === title.trim().toLowerCase();
        });
        if (matchMd) {
          cardMarkdown = strFromU8(unzipped[matchMd]!);
        }
      }

      cards.push({
        title: stripNotionUuid(title) || 'Untitled Card',
        columnName: status,
        priority,
        dueDate,
        tagNames,
        markdown: cardMarkdown,
      });
    }

    if (colNames.size === 0) {
      colNames.add('To Do');
      colNames.add('In Progress');
      colNames.add('Done');
    }

    boards.push({
      name: boardName,
      columns: Array.from(colNames).map((name) => ({ name })),
      cards,
    });
  }

  // Remaining .md files not inside a paired database folder -> Notepads tree
  const standaloneMds = mdFiles.filter((m) => {
    for (const dbFolder of databaseFolders) {
      if (m.startsWith(`${dbFolder}/`)) return false;
    }
    return true;
  });

  // Sort shallowest first so parents are registered before children
  standaloneMds.sort((a, b) => a.split('/').length - b.split('/').length || a.localeCompare(b));

  const dirToTempId = new Map<string, string>();
  const notepads: AnalyzedNotepad[] = [];
  let flattenedCount = 0;

  for (let i = 0; i < standaloneMds.length; i++) {
    const mdPath = standaloneMds[i]!;
    const parts = mdPath.split('/');
    const fileStem = stripNotionUuid(removeFileExtension(parts[parts.length - 1]!)) || 'Untitled';
    const dirPath = parts.slice(0, -1).join('/');
    const fullFolderKey = removeFileExtension(mdPath);

    let parentTempId: string | null = null;
    if (dirPath && dirToTempId.has(dirPath)) {
      parentTempId = dirToTempId.get(dirPath)!;
    }

    const rawDepth = Math.max(0, parts.length - 1);
    const depth = Math.min(rawDepth, MAX_NOTEPAD_DEPTH - 1);
    if (rawDepth >= MAX_NOTEPAD_DEPTH) {
      flattenedCount++;
    }

    const tempId = `notion_np_${i}`;
    dirToTempId.set(fullFolderKey, tempId);

    notepads.push({
      tempId,
      parentTempId,
      title: fileStem,
      markdown: strFromU8(unzipped[mdPath]!),
      depth,
    });
  }

  const mediaEntries = mediaFiles.map((archivePath) => ({
    archivePath,
    filename: archivePath.split('/').pop() ?? 'attachment',
    bytes: unzipped[archivePath]!,
  }));

  const limitations: string[] = [
    'Notion databases (.csv + companion folder) import as Kanban Boards + Card descriptions.',
    'Standard pages (.md) import as nested Notepads via BlockNote tryParseMarkdownToBlocks.',
    'Notion-specific features without Burrow equivalents (database formulas, rollups, synced blocks, and Notion permission groups) are not imported.',
  ];
  if (flattenedCount > 0) {
    limitations.push(
      `${flattenedCount} deeply nested page(s) beyond Burrow's ${MAX_NOTEPAD_DEPTH}-level tree limit will be placed at level ${MAX_NOTEPAD_DEPTH}.`,
    );
  }

  return {
    kind: 'notion-zip',
    workspaceName: 'Notion Import',
    notepadsCount: notepads.length,
    boardsCount: boards.length,
    cardsCount: boards.reduce((sum, b) => sum + b.cards.length, 0),
    mediaCount: mediaEntries.length,
    limitations,
    notionData: { notepads, boards, mediaEntries },
  };
}

function stripLeadingTitleHeading(markdown: string, title: string): string {
  const lines = markdown.replace(/\r\n/g, '\n').split('\n');
  if (lines[0]?.trim() === `# ${title}`.trim()) {
    let idx = 1;
    while (idx < lines.length && lines[idx]!.trim() === '') idx++;
    return lines.slice(idx).join('\n');
  }
  return markdown;
}

export async function convertNotionMarkdownToBlocksJson(
  editor: ReturnType<typeof BlockNoteEditor.create>,
  markdown: string,
  title: string,
  uploadedUrlByFilename: Map<string, string>,
): Promise<string> {
  const cleaned = stripLeadingTitleHeading(markdown, title);
  if (!cleaned.trim()) return '[]';
  try {
    const blocks = await editor.tryParseMarkdownToBlocks(cleaned);
    const rewriteUrls = (nodes: unknown[]): unknown[] =>
      nodes.map((raw) => {
        if (!raw || typeof raw !== 'object') return raw;
        const b = { ...(raw as Record<string, unknown>) };
        if (b.props && typeof b.props === 'object') {
          const props = { ...(b.props as Record<string, unknown>) };
          if (typeof props.url === 'string') {
            const decoded = decodeURIComponent(props.url).split('/').pop() ?? '';
            const uploaded = uploadedUrlByFilename.get(decoded);
            if (uploaded) props.url = uploaded;
          }
          b.props = props;
        }
        if (Array.isArray(b.children)) b.children = rewriteUrls(b.children);
        return b;
      });
    return JSON.stringify(rewriteUrls(blocks as unknown[]));
  } catch {
    return JSON.stringify([
      { type: 'paragraph', content: [{ type: 'text', text: cleaned, styles: {} }] },
    ]);
  }
}

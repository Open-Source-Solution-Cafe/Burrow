import { BlockNoteEditor } from '@blocknote/core';
import { zipSync, strToU8 } from 'fflate';
import { schema } from '../editor/schema';
import { serializeCsv } from '../../shared/csv';

export interface ExportManifestFile {
  storageKey: string;
  filename: string;
  contentType: string;
  byteSize: number | null;
  downloadUrl: string;
}

export interface ExportManifestNotepad {
  id: string;
  parentId: string | null;
  title: string;
  icon: string | null;
  coverKey: string | null;
  position: string;
  isFavorite: boolean;
  content: string;
  tagIds: string[];
  createdAt: number;
  updatedAt: number;
}

export interface ExportManifestCard {
  id: string;
  columnId: string;
  notepadId: string;
  title: string;
  priority: 'low' | 'medium' | 'high' | 'urgent' | null;
  dueDate: number | null;
  createdAt: number;
  assignees: Array<{ userId: string; name: string }>;
  tags: Array<{ id: string; name: string }>;
  content: string;
  subtasks: Array<{ id: string; title: string; completed: boolean }>;
}

export interface ExportManifestBoard {
  id: string;
  name: string;
  icon: string | null;
  columns: Array<{
    id: string;
    name: string;
    color: string | null;
    wipLimit: number | null;
    cards: ExportManifestCard[];
  }>;
}

export interface ExportManifestProject {
  id: string;
  name: string;
  icon: string | null;
  color: string | null;
  uploadPolicy?: {
    maxFileSizeBytes: number;
    allowedMimeTypes: string[];
  };
  tags: Array<{ id: string; name: string; color: string | null }>;
  notepads: ExportManifestNotepad[];
  boards: ExportManifestBoard[];
  files: ExportManifestFile[];
}

export interface WorkspaceExportManifest {
  schemaVersion: 'burrow-export-v1';
  exportedAt: number;
  workspace: {
    id: string;
    name: string;
    featureFlags?: Partial<
      Record<'workspaceExport' | 'notionImport' | 'publicSharing' | 'instanceMigration', boolean>
    >;
  };
  projects: ExportManifestProject[];
}

export interface MultiWorkspaceExportManifest {
  schemaVersion: 'burrow-multi-export-v1';
  exportedAt: number;
  workspaces: WorkspaceExportManifest[];
}

export function sanitizeArchiveSegment(name: string, fallback = 'untitled'): string {
  const cleaned = (name || '')
    .trim()
    .replace(/[\\/:*?"<>|]/g, '-')
    .replace(/\s+/g, ' ')
    .slice(0, 80);
  return cleaned || fallback;
}

function rewriteMediaUrl(
  url: string,
  storageKeyToMediaPath: Map<string, string>,
): string {
  for (const [key, relPath] of storageKeyToMediaPath.entries()) {
    if (url.includes(encodeURIComponent(key)) || url.includes(key)) {
      return relPath;
    }
  }
  return url;
}

export function preprocessBlocksForMarkdown(
  rawBlocks: unknown[],
  storageKeyToMediaPath: Map<string, string>,
  titleById: Map<string, string>,
): unknown[] {
  const mapInline = (items: unknown[]): unknown[] =>
    items.map((item) => {
      if (!item || typeof item !== 'object') return item;
      const obj = { ...(item as Record<string, unknown>) };
      if (obj.type === 'mention' && obj.props && typeof obj.props === 'object') {
        const props = obj.props as Record<string, unknown>;
        const label = String(props.label || props.isoDate || 'mention');
        const prefix = props.kind === 'tag' || label.startsWith('#') ? '' : '@';
        return { type: 'text', text: `${prefix}${label}`, styles: {} };
      }
      if (Array.isArray(obj.content)) {
        obj.content = mapInline(obj.content);
      }
      return obj;
    });

  return rawBlocks.map((raw) => {
    if (!raw || typeof raw !== 'object') return raw;
    const block = { ...(raw as Record<string, unknown>) };
    const props = (block.props && typeof block.props === 'object'
      ? { ...(block.props as Record<string, unknown>) }
      : {}) as Record<string, unknown>;

    if (block.type === 'notepadLink' || block.type === 'cardLink' || block.type === 'boardLink') {
      const id = String(props.notepadId || props.cardId || props.boardId || '');
      const title = titleById.get(id) || id || 'Reference';
      return {
        type: 'paragraph',
        content: [{ type: 'text', text: `[[${title}]]`, styles: {} }],
        children: Array.isArray(block.children)
          ? preprocessBlocksForMarkdown(block.children, storageKeyToMediaPath, titleById)
          : [],
      };
    }

    if (block.type === 'youtube') {
      const videoId = String(props.videoId || '');
      const ytUrl = videoId ? `https://www.youtube.com/watch?v=${videoId}` : '';
      return {
        type: 'paragraph',
        content: ytUrl ? [{ type: 'link', href: ytUrl, content: [{ type: 'text', text: ytUrl, styles: {} }] }] : [],
        children: [],
      };
    }

    if (block.type === 'file') {
      const name = String(props.name || 'Attachment');
      const url = rewriteMediaUrl(String(props.url || ''), storageKeyToMediaPath);
      return {
        type: 'paragraph',
        content: url
          ? [{ type: 'link', href: url, content: [{ type: 'text', text: name, styles: {} }] }]
          : [{ type: 'text', text: name, styles: {} }],
        children: [],
      };
    }

    if (typeof props.url === 'string') {
      props.url = rewriteMediaUrl(props.url, storageKeyToMediaPath);
      block.props = props;
    }
    if (Array.isArray(block.content)) {
      block.content = mapInline(block.content);
    }
    if (Array.isArray(block.children)) {
      block.children = preprocessBlocksForMarkdown(
        block.children,
        storageKeyToMediaPath,
        titleById,
      );
    }
    return block;
  });
}

function buildNotepadPathMap(notepads: ExportManifestNotepad[]): Map<string, string> {
  const byId = new Map(notepads.map((n) => [n.id, n]));
  const memo = new Map<string, string>();
  const usedPaths = new Set<string>();

  const resolve = (id: string, depth = 0): string => {
    if (memo.has(id)) return memo.get(id)!;
    const node = byId.get(id);
    if (!node || depth > 12) return sanitizeArchiveSegment(id);
    const base = sanitizeArchiveSegment(node.title, 'Untitled');
    const parentPath = node.parentId && byId.has(node.parentId) ? resolve(node.parentId, depth + 1) : '';
    let candidate = parentPath ? `${parentPath}/${base}` : base;
    let counter = 2;
    while (usedPaths.has(candidate)) {
      candidate = parentPath ? `${parentPath}/${base} (${counter})` : `${base} (${counter})`;
      counter++;
    }
    usedPaths.add(candidate);
    memo.set(id, candidate);
    return candidate;
  };

  for (const np of notepads) {
    resolve(np.id);
  }
  return memo;
}

async function populateWorkspaceExportFiles(
  files: Record<string, Uint8Array>,
  manifest: WorkspaceExportManifest,
  editor: BlockNoteEditor<any, any, any>,
  options: {
    includeMedia?: boolean;
    onProgress?: (msg: string) => void;
    prefix?: string;
  } = {},
): Promise<void> {
  const { includeMedia = true, onProgress, prefix = '' } = options;

  const toMarkdown = (rawContent: string, mediaMap: Map<string, string>, titleById: Map<string, string>): string => {
    try {
      const parsed = JSON.parse(rawContent);
      if (!Array.isArray(parsed) || parsed.length === 0) return '';
      const prepared = preprocessBlocksForMarkdown(parsed, mediaMap, titleById);
      return editor.blocksToMarkdownLossy(prepared as any);
    } catch {
      return '';
    }
  };

  files[`${prefix}burrow-backup.json`] = strToU8(JSON.stringify(manifest, null, 2));

  const usedProjectSlugs = new Set<string>();
  for (const project of manifest.projects) {
    let projectSlug = sanitizeArchiveSegment(project.name, project.id);
    if (usedProjectSlugs.has(projectSlug)) {
      projectSlug = `${projectSlug}-${project.id.slice(0, 6)}`;
    }
    usedProjectSlugs.add(projectSlug);
    const projectPrefix = `${prefix}projects/${projectSlug}`;

    const titleById = new Map<string, string>();
    for (const np of project.notepads) titleById.set(np.id, np.title);
    for (const b of project.boards) {
      titleById.set(b.id, b.name);
      for (const col of b.columns) {
        for (const c of col.cards) titleById.set(c.id, c.title);
      }
    }

    const storageKeyToRel = new Map<string, string>();
    const usedMediaNames = new Set<string>();
    for (const file of project.files) {
      let fname = sanitizeArchiveSegment(file.filename, 'file');
      if (usedMediaNames.has(fname)) {
        fname = `${file.storageKey.split('/').pop()?.slice(0, 6) ?? 'dup'}-${fname}`;
      }
      usedMediaNames.add(fname);
      storageKeyToRel.set(file.storageKey, `../media/${fname}`);

      if (includeMedia) {
        onProgress?.(`Downloading media: ${fname}...`);
        try {
          const res = await fetch(file.downloadUrl);
          if (res.ok) {
            files[`${projectPrefix}/media/${fname}`] = new Uint8Array(await res.arrayBuffer());
          }
        } catch {
          // Continue export even if an individual media file fails
        }
      }
    }

    // Export notepads (.md + lossless .blocknote.json)
    const pathMap = buildNotepadPathMap(project.notepads);
    for (const np of project.notepads) {
      const rel = pathMap.get(np.id) ?? sanitizeArchiveSegment(np.title, np.id);
      const mdBody = toMarkdown(np.content, storageKeyToRel, titleById);
      const header = `# ${np.title}\n\n`;
      files[`${projectPrefix}/notepads/${rel}.md`] = strToU8(`${header}${mdBody}`);
      files[`${projectPrefix}/notepads/${rel}.blocknote.json`] = strToU8(np.content || '[]');
    }

    // Export boards (.csv + card .md files)
    for (const board of project.boards) {
      const boardSlug = sanitizeArchiveSegment(board.name, board.id);
      const csvRows: Array<Array<string>> = [];
      for (const col of board.columns) {
        for (const card of col.cards) {
          const subtasksText = card.subtasks
            .map((s) => `[${s.completed ? 'x' : ' '}] ${s.title}`)
            .join('; ');
          csvRows.push([
            card.title,
            col.name,
            card.priority ?? '',
            card.dueDate ? new Date(card.dueDate).toISOString().slice(0, 10) : '',
            card.tags.map((t) => t.name).join(', '),
            card.assignees.map((a) => a.name).join(', '),
            subtasksText,
          ]);
          const cardMd = toMarkdown(card.content, storageKeyToRel, titleById);
          const cardSlug = sanitizeArchiveSegment(card.title, card.id);
          files[`${projectPrefix}/boards/${boardSlug}/cards/${cardSlug}.md`] = strToU8(
            `# ${card.title}\n\n${cardMd}`,
          );
        }
      }
      const csvString = serializeCsv(
        ['Title', 'Column', 'Priority', 'Due Date', 'Tags', 'Assignees', 'Subtasks'],
        csvRows,
      );
      files[`${projectPrefix}/boards/${boardSlug}.csv`] = strToU8(csvString);
    }
  }
}

export async function buildWorkspaceExportZip(
  manifest: WorkspaceExportManifest,
  options: {
    includeMedia?: boolean;
    onProgress?: (msg: string) => void;
  } = {},
): Promise<Uint8Array> {
  const { includeMedia = true, onProgress } = options;
  const files: Record<string, Uint8Array> = {};
  const editor = BlockNoteEditor.create({ schema });

  onProgress?.('Writing lossless backup manifest...');
  await populateWorkspaceExportFiles(files, manifest, editor, { includeMedia, onProgress });

  onProgress?.('Compressing ZIP archive...');
  return zipSync(files, { level: 6 });
}

/** Packages one or more workspace export manifests into a single ZIP archive. */
export async function buildMultiWorkspaceExportZip(
  manifests: WorkspaceExportManifest[],
  options: {
    includeMedia?: boolean;
    onProgress?: (msg: string) => void;
  } = {},
): Promise<Uint8Array> {
  if (manifests.length === 0) {
    throw new Error('Select at least one workspace to export');
  }
  if (manifests.length === 1) {
    return buildWorkspaceExportZip(manifests[0]!, options);
  }

  const { includeMedia = true, onProgress } = options;
  const files: Record<string, Uint8Array> = {};
  const editor = BlockNoteEditor.create({ schema });

  onProgress?.(`Writing multi-workspace backup (${manifests.length} workspaces)...`);
  const multiManifest: MultiWorkspaceExportManifest = {
    schemaVersion: 'burrow-multi-export-v1',
    exportedAt: Date.now(),
    workspaces: manifests,
  };
  files['burrow-multi-workspace-backup.json'] = strToU8(JSON.stringify(multiManifest, null, 2));

  const usedWorkspaceSlugs = new Set<string>();
  for (const manifest of manifests) {
    let wsSlug = sanitizeArchiveSegment(manifest.workspace.name, manifest.workspace.id);
    if (usedWorkspaceSlugs.has(wsSlug)) {
      wsSlug = `${wsSlug}-${manifest.workspace.id.slice(0, 6)}`;
    }
    usedWorkspaceSlugs.add(wsSlug);
    onProgress?.(`Packaging workspace: ${manifest.workspace.name}...`);
    await populateWorkspaceExportFiles(files, manifest, editor, {
      includeMedia,
      onProgress,
      prefix: `workspaces/${wsSlug}/`,
    });
  }

  onProgress?.('Compressing ZIP archive...');
  return zipSync(files, { level: 6 });
}

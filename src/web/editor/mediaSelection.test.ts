import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import * as blocknoteCore from '@blocknote/core';
import { MEDIA_BLOCK_TYPES, selectMediaBlock } from './mediaSelection';

vi.mock('@blocknote/core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@blocknote/core')>();
  return {
    ...actual,
    getNodeById: vi.fn(),
  };
});

describe('mediaSelection', () => {
  it('includes all supported media block types', () => {
    expect([...MEDIA_BLOCK_TYPES]).toEqual(['image', 'video', 'audio', 'file', 'youtube']);
  });

  it('selects the media block content node and focuses the editor when editable', () => {
    const getNodeByIdMock = vi.mocked(blocknoteCore.getNodeById);
    getNodeByIdMock.mockReturnValue({ node: {} as never, posBeforeNode: 12 });

    const setNodeSelection = vi.fn(() => true);
    const focus = vi.fn();
    const editor = {
      isEditable: true,
      prosemirrorState: { doc: {} },
      isFocused: vi.fn(() => false),
      focus,
      _tiptapEditor: { commands: { setNodeSelection } },
    };

    expect(selectMediaBlock(editor as never, 'block-1')).toBe(true);
    expect(getNodeByIdMock).toHaveBeenCalledWith('block-1', editor.prosemirrorState.doc);
    expect(setNodeSelection).toHaveBeenCalledWith(13);
    expect(focus).toHaveBeenCalledOnce();
  });

  it('does not re-focus when already focused and returns false when read-only or missing', () => {
    const getNodeByIdMock = vi.mocked(blocknoteCore.getNodeById);
    const setNodeSelection = vi.fn(() => true);
    const focus = vi.fn();

    const readOnlyEditor = { isEditable: false };
    expect(selectMediaBlock(readOnlyEditor as never, 'block-1')).toBe(false);

    getNodeByIdMock.mockReturnValueOnce(undefined);
    const missingNodeEditor = {
      isEditable: true,
      prosemirrorState: { doc: {} },
      isFocused: vi.fn(() => true),
      focus,
      _tiptapEditor: { commands: { setNodeSelection } },
    };
    expect(selectMediaBlock(missingNodeEditor as never, 'missing')).toBe(false);
    expect(focus).not.toHaveBeenCalled();

    getNodeByIdMock.mockReturnValueOnce({ node: {} as never, posBeforeNode: 5 });
    expect(selectMediaBlock(missingNodeEditor as never, 'block-2')).toBe(true);
    expect(setNodeSelection).toHaveBeenCalledWith(6);
    expect(focus).not.toHaveBeenCalled();
  });
});

describe('notepad media & layout regression checks', () => {
  const repoRoot = resolve(import.meta.dirname, '../../..');

  it('keeps BlockNote media alignment rules without forcing wrapper width: 100%', () => {
    const css = readFileSync(resolve(repoRoot, 'src/web/index.css'), 'utf8');
    expect(css).toContain(".bn-root .bn-block-content[data-text-alignment='center']");
    expect(css).toContain(".bn-root .bn-block-content[data-text-alignment='right']");
    expect(css).toContain(".bn-root .bn-block-content[data-text-alignment='left']");
    expect(css).toContain('margin-inline: auto');
    expect(css).toContain('.bn-root .burrow-media-menu-btn');

    const centerWrapperBlock = css.match(
      /\.bn-root \.bn-block-content\[data-text-alignment='center'\] > \.bn-file-block-content-wrapper\s*\{[^}]*\}/,
    )?.[0];
    expect(centerWrapperBlock).toBeDefined();
    expect(centerWrapperBlock).not.toContain('width: 100%');
  });

  it('keeps wide centered notepad canvas, right-click suppression, and media menu triggers in NotepadEditor', () => {
    const editorTsx = readFileSync(resolve(repoRoot, 'src/web/editor/NotepadEditor.tsx'), 'utf8');
    expect(editorTsx).toContain('max-w-[1200px] mx-auto');
    expect(editorTsx).not.toContain('max-w-[780px]');
    expect(editorTsx).toContain('onContextMenu={handleEditorContextMenu}');
    expect(editorTsx).toContain('event.preventDefault()');
    expect(editorTsx).toContain('burrow-media-menu-btn');
    expect(editorTsx).toContain('selectMediaBlock(editor, blockId)');
  });

  it('keeps BlockNote and Hono credit badges in README.md', () => {
    const readme = readFileSync(resolve(repoRoot, 'README.md'), 'utf8');
    expect(readme).toContain('[![BlockNote]');
    expect(readme).toContain('[![Hono]');
  });

  it('unifies YouTube and File media blocks around MediaBlockFrame with side-drag resizing and textAlignment schema props', () => {
    const mediaFrameTsx = readFileSync(resolve(repoRoot, 'src/web/editor/MediaBlockFrame.tsx'), 'utf8');
    const youtubeTsx = readFileSync(resolve(repoRoot, 'src/web/editor/YoutubeMedia.tsx'), 'utf8');
    const fileTsx = readFileSync(resolve(repoRoot, 'src/web/editor/FileMedia.tsx'), 'utf8');
    const schemaTsx = readFileSync(resolve(repoRoot, 'src/web/editor/schema.tsx'), 'utf8');
    const css = readFileSync(resolve(repoRoot, 'src/web/index.css'), 'utf8');

    expect(mediaFrameTsx).toContain('bn-file-block-content-wrapper');
    expect(mediaFrameTsx).toContain('bn-resize-handle');
    expect(youtubeTsx).toContain('<MediaBlockFrame');
    expect(youtubeTsx).not.toContain('type="range"');
    expect(youtubeTsx).not.toContain('media-block-actions');
    expect(fileTsx).toContain('<MediaBlockFrame');
    expect(css).not.toContain('.media-block-actions');
    expect(css).toContain('.bn-root .bn-resize-handle');

    expect(schemaTsx).toMatch(/FileBlock[\s\S]*?textAlignment:\s*defaultProps\.textAlignment/);
    expect(schemaTsx).toMatch(/YoutubeBlock[\s\S]*?textAlignment:\s*defaultProps\.textAlignment/);
  });
});

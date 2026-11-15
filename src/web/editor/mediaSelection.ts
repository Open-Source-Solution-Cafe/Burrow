import { getNodeById, type BlockNoteEditor } from '@blocknote/core';

export const MEDIA_BLOCK_TYPES = new Set(['image', 'video', 'audio', 'file', 'youtube']);

/**
 * Selects a media block node in ProseMirror and focuses the editor so BlockNote's
 * floating media toolbar opens reliably on desktop and mobile.
 */
export function selectMediaBlock(editor: BlockNoteEditor<any, any, any>, blockId: string): boolean {
  if (!editor?.isEditable) return false;
  const doc = editor.prosemirrorState?.doc;
  if (!doc) return false;

  const found = getNodeById(blockId, doc);
  if (!found) return false;

  const contentPos = found.posBeforeNode + 1;
  const tiptap = (
    editor as unknown as {
      _tiptapEditor?: { commands?: { setNodeSelection?: (pos: number) => boolean } };
    }
  )._tiptapEditor;

  const selected = tiptap?.commands?.setNodeSelection?.(contentPos) ?? false;
  if (!editor.isFocused()) {
    editor.focus();
  }
  return selected;
}

import { useState } from 'react';
import { useBlockNoteEditor, useExtension, type FilePanelProps } from '@blocknote/react';
import { FilePanelExtension } from '@blocknote/core/extensions';
import { toast } from 'sonner';
import { MediaUploadControl } from '../components/media/ProjectMediaLibrary';
import { Input } from '../components/ui/Input';
import { Button } from '../components/ui/Button';
import { schema } from './schema';
import { parseMediaUrl } from './mediaUrl';
import { getUploadFileType } from '../../shared/uploadPolicy';
import { useTranslation } from '../lib/i18n';

/** Empty attachments share the library's scoped upload, policy, and retry flow. */
export function EditorFilePanel({ blockId, workspaceId, projectId }: FilePanelProps & { workspaceId: string; projectId: string }) {
  const { t } = useTranslation();
  const editor = useBlockNoteEditor(schema);
  const panel = useExtension(FilePanelExtension);
  const [url, setUrl] = useState('');
  const [busy, setBusy] = useState(false);
  const insert = (file: { url: string; name: string; contentType?: string }) => {
    const block = editor.getBlock(blockId);
    if (!editor.isEditable || !block) {
      throw new Error(t('editor.attachmentCannotBeEdited'));
    }
    const contentType = file.contentType ?? getUploadFileType({ name: new URL(file.url, window.location.origin).pathname, type: '' })?.mimeType;
    const family = contentType?.split('/')[0];
    const type = block.type === 'file' ? 'file' : family === 'image' || family === 'audio' || family === 'video' ? family : 'file';
    editor.updateBlock(blockId, { type, props: { url: file.url, name: file.name } });
    panel.closeMenu();
  };
  return (
    <div className="w-80 max-w-[calc(100vw-2rem)] space-y-4 border border-[var(--line)] bg-[var(--surface)] p-4 text-[var(--text)] theme-radius-xs">
      <MediaUploadControl workspaceId={workspaceId} projectId={projectId} onBusyChange={setBusy} onUploaded={insert} />
      <form className="space-y-2 border-t border-[var(--line)] pt-3" onSubmit={(event) => {
        event.preventDefault();
        if (!parseMediaUrl(url)) { toast.error(t('editor.validUrlPrompt')); return; }
        try { insert({ url: url.trim(), name: '' }); }
        catch (error) { toast.error(error instanceof Error ? error.message : t('editor.couldNotEmbedFile')); }
      }}>
        <Input aria-label={t('editor.fileUrl')} placeholder="https://example.com/file.pdf" value={url} disabled={busy} onChange={(event) => setUrl(event.target.value)} />
        <Button type="submit" disabled={busy || !url.trim()}>{t('editor.embedFile')}</Button>
      </form>
    </div>
  );
}

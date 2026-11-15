import type { BlockNoteEditor } from '@blocknote/core';
import { useEditorState, useExtension } from '@blocknote/react';
import { FilePanelExtension } from '@blocknote/core/extensions';
import {
  File as FileIcon,
  FileArchive,
  FileSpreadsheet,
  FileText,
  Film,
  Image as ImageIcon,
  Music,
  Upload,
} from 'lucide-react';
import { toast } from 'sonner';
import { MediaBlockFrame } from './MediaBlockFrame';
import { mediaWidthPercent } from './mediaLayout';
import { mediaKindFromFile } from './mediaUrl';

function getFileExtension(name: string, url: string): string {
  const fromName = name.split('.').pop()?.trim();
  if (fromName && fromName !== name && fromName.length <= 6) {
    return fromName.toUpperCase();
  }
  try {
    const pathname = new URL(url, window.location.origin).pathname;
    const fromUrl = pathname.split('.').pop()?.trim();
    if (fromUrl && fromUrl !== pathname && fromUrl.length <= 6) {
      return fromUrl.toUpperCase();
    }
  } catch {
    // Ignore malformed URLs and fall back to generic label.
  }
  return '';
}

function getFileDisplayName(name: string, url: string): string {
  if (name.trim()) return name.trim();
  try {
    const segment = new URL(url, window.location.origin).pathname.split('/').pop();
    if (segment) return decodeURIComponent(segment);
  } catch {
    // Ignore malformed URLs.
  }
  return 'Attachment';
}

function DocumentTypeIcon({ ext }: { ext: string }) {
  if (ext === 'CSV' || ext === 'XLSX') return <FileSpreadsheet className="h-4 w-4" />;
  if (ext === 'ZIP') return <FileArchive className="h-4 w-4" />;
  if (ext === 'PDF' || ext === 'DOCX' || ext === 'PPTX' || ext === 'TXT') {
    return <FileText className="h-4 w-4" />;
  }
  return <FileIcon className="h-4 w-4" />;
}

export function FileMedia({
  editor,
  block,
}: {
  editor: BlockNoteEditor<any, any, any>;
  block: {
    id: string;
    props: {
      url: string;
      name: string;
      caption?: string;
      widthPercent?: number;
      textAlignment?: 'left' | 'center' | 'right' | 'justify';
    };
  };
}) {
  const panel = useExtension(FilePanelExtension);
  const editable = useEditorState({
    editor,
    selector: ({ editor: current }) => Boolean(current?.isEditable),
  });

  const url = block.props.url?.trim() ?? '';
  if (!url) {
    return (
      <div
        className="my-1.5 flex items-center gap-2.5 border border-dashed border-[var(--line)] bg-[var(--surface2)] px-4 py-3 text-sm text-[var(--muted)] theme-radius-md transition-colors hover:border-[var(--muted)] hover:bg-[var(--hi)] hover:text-[var(--text)] cursor-pointer select-none"
        contentEditable={false}
        onMouseDown={(event) => event.preventDefault()}
        onClick={() => {
          if (editable) {
            editor.transact(() => panel.showMenu(block.id));
          }
        }}
      >
        <Upload className="h-4 w-4 shrink-0" />
        <span>Add file</span>
      </div>
    );
  }

  const displayName = getFileDisplayName(block.props.name ?? '', url);
  const ext = getFileExtension(displayName, url);
  const kind = mediaKindFromFile('', `${displayName}.${ext.toLowerCase()}`);
  const caption = block.props.caption?.trim();

  const icon =
    kind === 'video' ? (
      <Film className="h-3.5 w-3.5" />
    ) : kind === 'image' ? (
      <ImageIcon className="h-3.5 w-3.5" />
    ) : kind === 'audio' ? (
      <Music className="h-4 w-4" />
    ) : (
      <DocumentTypeIcon ext={ext} />
    );

  const preview =
    kind === 'video' ? (
      <video
        controls
        preload="metadata"
        src={url}
        className="block w-full max-h-[540px] bg-black object-contain"
      />
    ) : kind === 'image' ? (
      <img
        src={url}
        alt={displayName}
        loading="lazy"
        className="block w-full max-h-[540px] object-contain"
      />
    ) : kind === 'audio' ? (
      <div className="p-3">
        <audio controls preload="metadata" src={url} className="w-full" />
      </div>
    ) : undefined;

  return (
    <MediaBlockFrame
      editor={editor}
      blockId={block.id}
      textAlignment={block.props.textAlignment}
      widthPercent={block.props.widthPercent ?? 100}
      resizable={kind === 'video' || kind === 'image'}
      onWidthPercentChange={(nextWidthPercent) => {
        if (!editor.isEditable) return;
        try {
          editor.updateBlock(block.id, {
            props: { widthPercent: mediaWidthPercent(nextWidthPercent) },
          });
        } catch {
          toast.error('Could not resize this file');
        }
      }}
      icon={icon}
      title={displayName}
      badge={ext || undefined}
      openHref={url}
      openLabel="Open"
      caption={caption}
      removeTitle="Remove file"
      removeMessage="Remove this file from the note? You can undo this change in the editor."
      removeErrorToast="Could not remove this file"
    >
      {preview}
    </MediaBlockFrame>
  );
}

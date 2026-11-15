import type { BlockNoteEditor } from '@blocknote/core';
import { Play } from 'lucide-react';
import { toast } from 'sonner';
import { MediaBlockFrame } from './MediaBlockFrame';
import { mediaWidthPercent } from './mediaLayout';
import { isYoutubeVideoId } from './mediaUrl';

export function YoutubeMedia({
  editor,
  block,
}: {
  editor: BlockNoteEditor<any, any, any>;
  block: {
    id: string;
    props: {
      videoId: string;
      widthPercent: number;
      textAlignment?: 'left' | 'center' | 'right' | 'justify';
    };
  };
}) {
  const validVideo = isYoutubeVideoId(block.props.videoId);
  const videoUrl = `https://www.youtube.com/watch?v=${block.props.videoId}`;

  return (
    <MediaBlockFrame
      editor={editor}
      blockId={block.id}
      textAlignment={block.props.textAlignment}
      widthPercent={block.props.widthPercent}
      resizable={validVideo}
      onWidthPercentChange={(nextWidthPercent) => {
        if (!editor.isEditable) return;
        try {
          editor.updateBlock(block.id, {
            props: { widthPercent: mediaWidthPercent(nextWidthPercent) },
          });
        } catch {
          toast.error('Could not resize this video');
        }
      }}
      icon={<Play className="h-3.5 w-3.5 shrink-0 text-[var(--accent)]" />}
      title="YouTube"
      openHref={validVideo ? videoUrl : undefined}
      openLabel="Open on YouTube"
      removeTitle="Remove video"
      removeMessage="Remove this video from the note? You can undo this change in the editor."
      removeErrorToast="Could not remove this video"
    >
      {validVideo ? (
        <iframe
          className="block w-full aspect-video"
          src={`https://www.youtube-nocookie.com/embed/${block.props.videoId}`}
          title="YouTube video"
          loading="lazy"
          allow="encrypted-media; picture-in-picture; fullscreen"
          allowFullScreen
          referrerPolicy="strict-origin-when-cross-origin"
          sandbox="allow-scripts allow-same-origin allow-presentation"
        />
      ) : (
        <div className="flex min-h-24 items-center px-4 text-sm text-[var(--muted)]">
          Video unavailable
        </div>
      )}
    </MediaBlockFrame>
  );
}

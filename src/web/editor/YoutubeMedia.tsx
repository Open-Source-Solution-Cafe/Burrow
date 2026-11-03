import { useEffect, useRef, useState } from 'react';
import type { BlockNoteEditor } from '@blocknote/core';
import { useEditorState } from '@blocknote/react';
import { toast } from 'sonner';
import { ExternalLink, MoreHorizontal, Trash2 } from 'lucide-react';
import { ConfirmDialog } from '../components/ui/ConfirmDialog';
import { isYoutubeVideoId } from './mediaUrl';
import { mediaWidthPercent } from './mediaLayout';

export function YoutubeMedia({
  editor,
  block,
}: {
  editor: BlockNoteEditor<any, any, any>;
  block: { id: string; props: { videoId: string; widthPercent: number } };
}) {
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [optionsOpen, setOptionsOpen] = useState(false);
  // Freeze the control anchor for the entire edit; the player can resize beneath it.
  const [optionsWidth, setOptionsWidth] = useState(100);
  const optionsRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (!optionsOpen) return;
    const close = (event: PointerEvent) => {
      if (!optionsRef.current?.contains(event.target as Node)) setOptionsOpen(false);
    };
    document.addEventListener('pointerdown', close);
    return () => document.removeEventListener('pointerdown', close);
  }, [optionsOpen]);
  const editable = useEditorState({
    editor,
    selector: ({ editor: current }) => Boolean(current?.isEditable),
  });
  const width = mediaWidthPercent(block.props.widthPercent);
  const validVideo = isYoutubeVideoId(block.props.videoId);
  const videoUrl = `https://www.youtube.com/watch?v=${block.props.videoId}`;
  return (
    <div className="media-block relative w-full my-2" contentEditable={false}>
      {editable && (
        <div
          className="pointer-events-none absolute inset-x-0 top-0 mx-auto"
          style={{ width: `${optionsOpen ? optionsWidth : width}%` }}
        >
          <div
            ref={optionsRef}
            draggable={false}
            className={`media-block-actions pointer-events-auto no-print absolute right-2 top-2 z-10 ${optionsOpen ? 'media-block-actions-open' : ''}`}
            onPointerDown={(event) => event.stopPropagation()}
            onMouseDown={(event) => event.stopPropagation()}
            onTouchStart={(event) => event.stopPropagation()}
            onDragStart={(event) => {
              event.preventDefault();
              event.stopPropagation();
            }}
            onBlur={(event) => {
              if (!event.currentTarget.contains(event.relatedTarget)) setOptionsOpen(false);
            }}
            onKeyDown={(event) => {
              event.stopPropagation();
              if (event.key === 'Escape') {
                setOptionsOpen(false);
                triggerRef.current?.focus();
              }
            }}
          >
            <button
              ref={triggerRef}
              type="button"
              aria-label="Video options"
              aria-expanded={optionsOpen}
              onClick={() => {
                if (!optionsOpen) setOptionsWidth(width);
                setOptionsOpen((open) => !open);
              }}
              className="flex h-11 w-11 md:h-9 md:w-9 items-center justify-center theme-radius-md border border-[var(--line)] bg-[var(--surface)] text-[var(--muted)] hover:text-[var(--text)] focus-visible:outline-2 focus-visible:outline-[var(--accent)]"
            >
              <MoreHorizontal className="h-4 w-4" />
            </button>
            {optionsOpen && (
              <div
                className="absolute right-0 top-full mt-1 w-56 theme-radius-md border border-[var(--line)] bg-[var(--surface)] p-1 text-xs text-[var(--text)]"
                role="group"
                aria-label="Video options"
              >
                <label className="block px-3 py-2">
                  <span className="mb-2 flex justify-between text-[var(--muted)]">
                    Width <span className="tabular-nums">{width}%</span>
                  </span>
                  <input
                    aria-label="Video width"
                    type="range"
                    min={25}
                    max={100}
                    step={5}
                    value={width}
                      className="block w-full touch-none accent-[var(--accent)]"
                    onPointerDown={(event) => {
                      event.stopPropagation();
                      event.currentTarget.setPointerCapture(event.pointerId);
                    }}
                    onChange={(event) => {
                      if (!editor.isEditable) return;
                      try {
                        editor.updateBlock(block.id, {
                          props: { widthPercent: mediaWidthPercent(Number(event.target.value)) },
                        });
                      } catch {
                        toast.error('Could not resize this video');
                      }
                    }}
                  />
                </label>
                {validVideo && (
                  <a
                    href={videoUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="flex items-center gap-2 px-3 py-2 hover:bg-[var(--hi)]"
                  >
                    <ExternalLink className="h-3.5 w-3.5" /> Open on YouTube
                  </a>
                )}
                <button
                  type="button"
                  className="flex w-full items-center gap-2 px-3 py-2 text-[var(--danger)] hover:bg-[var(--hi)]"
                  onClick={() => {
                    setOptionsOpen(false);
                    setConfirmDelete(true);
                  }}
                >
                  <Trash2 className="h-3.5 w-3.5" /> Remove video
                </button>
              </div>
            )}
          </div>
        </div>
      )}
      <div className="mx-auto" style={{ width: `${width}%` }}>
        {validVideo ? (
          <>
            <iframe
              className="w-full aspect-video border border-[var(--line)]"
              src={`https://www.youtube-nocookie.com/embed/${block.props.videoId}`}
              title="YouTube video"
              loading="lazy"
              allow="encrypted-media; picture-in-picture; fullscreen"
              allowFullScreen
              referrerPolicy="strict-origin-when-cross-origin"
              sandbox="allow-scripts allow-same-origin allow-presentation"
            />
          </>
        ) : (
          <div className="min-h-24 flex items-center px-4 text-sm text-[var(--muted)] bg-[var(--surface2)]">
            Video unavailable
          </div>
        )}
      </div>
      <ConfirmDialog
        open={confirmDelete && editable}
        title="Remove video"
        message="Remove this video from the note? You can undo this change in the editor."
        confirmLabel="Remove video"
        onCancel={() => setConfirmDelete(false)}
        onConfirm={() => {
          if (!editor.isEditable) return;
          try {
            editor.removeBlocks([block.id]);
            setConfirmDelete(false);
          } catch {
            toast.error('Could not remove this video');
          }
        }}
      />
    </div>
  );
}

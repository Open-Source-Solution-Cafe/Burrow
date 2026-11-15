import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import type { BlockNoteEditor } from '@blocknote/core';
import { useEditorState } from '@blocknote/react';
import { ExternalLink, MoreHorizontal, Trash2 } from 'lucide-react';
import { toast } from 'sonner';
import { ConfirmDialog } from '../components/ui/ConfirmDialog';
import { mediaWidthPercent } from './mediaLayout';
import { selectMediaBlock } from './mediaSelection';

export interface MediaBlockFrameProps {
  editor: BlockNoteEditor<any, any, any>;
  blockId: string;
  textAlignment?: 'left' | 'center' | 'right' | 'justify';
  widthPercent?: number;
  resizable?: boolean;
  onWidthPercentChange?: (nextWidthPercent: number) => void;
  icon: ReactNode;
  title: string;
  badge?: string;
  openHref?: string;
  openLabel?: string;
  caption?: string;
  removeTitle: string;
  removeMessage: string;
  removeErrorToast?: string;
  children?: ReactNode;
}

interface ResizeState {
  handle: 'left' | 'right';
  startX: number;
  startWidthPx: number;
  containerWidthPx: number;
}

function getClientX(event: MouseEvent | TouchEvent | React.MouseEvent | React.TouchEvent): number {
  if ('touches' in event) {
    const touch = event.touches[0];
    if (touch) return touch.clientX;
  }
  if ('changedTouches' in event) {
    const touch = event.changedTouches[0];
    if (touch) return touch.clientX;
  }
  return 'clientX' in event ? event.clientX : 0;
}

/**
 * Reusable media block frame providing BlockNote-compatible alignment, side-drag width resizing,
 * footer bar actions, selection trigger, and removal confirmation.
 */
export function MediaBlockFrame({
  editor,
  blockId,
  textAlignment = 'left',
  widthPercent = 100,
  resizable = false,
  onWidthPercentChange,
  icon,
  title,
  badge,
  openHref,
  openLabel = 'Open',
  caption,
  removeTitle,
  removeMessage,
  removeErrorToast = 'Could not remove this media block',
  children,
}: MediaBlockFrameProps) {
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [hovered, setHovered] = useState(false);
  const [resizeState, setResizeState] = useState<ResizeState | null>(null);
  const [draftWidthPercent, setDraftWidthPercent] = useState<number | null>(null);

  const wrapperRef = useRef<HTMLDivElement>(null);
  const draftWidthRef = useRef<number | null>(null);
  const onWidthChangeRef = useRef(onWidthPercentChange);
  onWidthChangeRef.current = onWidthPercentChange;

  const editable = useEditorState({
    editor,
    selector: ({ editor: current }) => Boolean(current?.isEditable),
  });

  const propWidthPercent = mediaWidthPercent(widthPercent);
  const activeWidthPercent = draftWidthPercent ?? propWidthPercent;

  useEffect(() => {
    if (!resizeState) return;

    const handleMove = (event: MouseEvent | TouchEvent) => {
      const clientX = getClientX(event);
      const rawDelta =
        resizeState.handle === 'left'
          ? resizeState.startX - clientX
          : clientX - resizeState.startX;
      const multiplier = textAlignment === 'center' ? 2 : 1;
      const nextWidthPx = resizeState.startWidthPx + rawDelta * multiplier;
      const nextPercent = mediaWidthPercent((nextWidthPx / resizeState.containerWidthPx) * 100);
      draftWidthRef.current = nextPercent;
      setDraftWidthPercent(nextPercent);
    };

    const handleUp = () => {
      const finalPercent = draftWidthRef.current;
      draftWidthRef.current = null;
      setDraftWidthPercent(null);
      setResizeState(null);
      if (finalPercent !== null && finalPercent !== propWidthPercent) {
        onWidthChangeRef.current?.(finalPercent);
      }
    };

    window.addEventListener('mousemove', handleMove);
    window.addEventListener('touchmove', handleMove);
    window.addEventListener('mouseup', handleUp);
    window.addEventListener('touchend', handleUp);

    return () => {
      window.removeEventListener('mousemove', handleMove);
      window.removeEventListener('touchmove', handleMove);
      window.removeEventListener('mouseup', handleUp);
      window.removeEventListener('touchend', handleUp);
    };
  }, [resizeState, textAlignment, propWidthPercent]);

  const startResize = useCallback(
    (handle: 'left' | 'right') => (event: React.MouseEvent | React.TouchEvent) => {
      if (!editable || !resizable) return;
      event.preventDefault();
      event.stopPropagation();

      const wrapperEl = wrapperRef.current;
      if (!wrapperEl) return;

      const containerEl =
        wrapperEl.closest<HTMLElement>('.bn-block-content') ??
        wrapperEl.closest<HTMLElement>('.bn-editor');
      const startWidthPx = wrapperEl.getBoundingClientRect().width;
      const containerWidthPx = containerEl?.getBoundingClientRect().width || startWidthPx || 1;
      const startX = getClientX(event);

      draftWidthRef.current = propWidthPercent;
      setDraftWidthPercent(propWidthPercent);
      setResizeState({
        handle,
        startX,
        startWidthPx,
        containerWidthPx,
      });
    },
    [editable, resizable, propWidthPercent],
  );

  const actions = (
    <div className="flex items-center gap-1 shrink-0">
      {openHref && (
        <a
          href={openHref}
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex h-7 items-center gap-1.5 px-2.5 text-xs font-medium text-[var(--muted)] hover:text-[var(--text)] hover:bg-[var(--hi)] theme-radius-xs transition-colors"
          onClick={(event) => event.stopPropagation()}
        >
          <span>{openLabel}</span>
          <ExternalLink className="h-3 w-3" />
        </a>
      )}
      {editable && (
        <>
          <button
            type="button"
            aria-label="Media options"
            title="Media options"
            onPointerDown={(event) => {
              event.preventDefault();
              event.stopPropagation();
            }}
            onClick={(event) => {
              event.stopPropagation();
              selectMediaBlock(editor, blockId);
            }}
            className="inline-flex h-7 w-7 items-center justify-center text-[var(--muted)] hover:text-[var(--text)] hover:bg-[var(--hi)] theme-radius-xs transition-colors cursor-pointer"
          >
            <MoreHorizontal className="h-3.5 w-3.5" />
          </button>
          <button
            type="button"
            aria-label={removeTitle}
            title={removeTitle}
            onClick={(event) => {
              event.stopPropagation();
              setConfirmDelete(true);
            }}
            className="inline-flex h-7 w-7 items-center justify-center text-[var(--muted)] hover:text-[var(--danger)] hover:bg-[var(--hi)] theme-radius-xs transition-colors cursor-pointer"
          >
            <Trash2 className="h-3.5 w-3.5" />
          </button>
        </>
      )}
    </div>
  );

  const meta = (
    <div className="flex min-w-0 items-center gap-2">
      <span className="inline-flex shrink-0 items-center justify-center text-[var(--accent)]">
        {icon}
      </span>
      <span className="truncate text-xs font-medium text-[var(--text)]" title={title}>
        {title}
      </span>
      {badge && (
        <span className="shrink-0 border border-[var(--line)] bg-[var(--surface2)] px-1.5 py-0.5 text-[10px] font-semibold uppercase text-[var(--muted)] theme-radius-xs">
          {badge}
        </span>
      )}
    </div>
  );

  const showHandles = resizable && editable && (hovered || resizeState !== null);

  return (
    <div
      ref={wrapperRef}
      className="bn-file-block-content-wrapper media-block my-2"
      contentEditable={false}
      style={{ width: resizable ? `${activeWidthPercent}%` : '100%' }}
      onMouseEnter={resizable && editable ? () => setHovered(true) : undefined}
      onMouseLeave={resizable && editable ? () => setHovered(false) : undefined}
      onClick={(event) => {
        const target = event.target as HTMLElement | null;
        if (!target || target.closest('a, button, video, audio, iframe')) return;
        selectMediaBlock(editor, blockId);
      }}
    >
      {children ? (
        <div className="w-full overflow-hidden border border-[var(--line)] bg-[var(--surface2)] theme-radius-md">
          {resizable ? (
            <div className="bn-visual-media-wrapper relative w-full">
              {children}
              {editable && (
                <>
                  <div
                    className="bn-resize-handle no-print"
                    style={{
                      left: '4px',
                      display: showHandles ? 'block' : 'none',
                    }}
                    onMouseDown={startResize('left')}
                    onTouchStart={startResize('left')}
                  />
                  <div
                    className="bn-resize-handle no-print"
                    style={{
                      right: '4px',
                      display: showHandles ? 'block' : 'none',
                    }}
                    onMouseDown={startResize('right')}
                    onTouchStart={startResize('right')}
                  />
                </>
              )}
              {resizeState && <div className="absolute inset-0 z-10 cursor-ew-resize" />}
            </div>
          ) : (
            children
          )}
          <div className="flex items-center justify-between gap-3 border-t border-[var(--line)] bg-[var(--surface)] px-3 py-2">
            {meta}
            {actions}
          </div>
        </div>
      ) : (
        <div className="flex w-full items-center justify-between gap-3 border border-[var(--line)] bg-[var(--surface2)] px-3.5 py-2.5 theme-radius-md transition-colors hover:border-[var(--muted)]">
          <div className="flex min-w-0 items-center gap-3">
            <div className="flex h-9 w-9 shrink-0 items-center justify-center border border-[var(--line)] bg-[var(--surface)] text-[var(--accent)] theme-radius-xs">
              {icon}
            </div>
            <div className="flex min-w-0 items-center gap-2">
              <span className="truncate text-sm font-medium text-[var(--text)]" title={title}>
                {title}
              </span>
              {badge && (
                <span className="shrink-0 border border-[var(--line)] bg-[var(--surface)] px-1.5 py-0.5 text-[10px] font-semibold uppercase text-[var(--muted)] theme-radius-xs">
                  {badge}
                </span>
              )}
            </div>
          </div>
          {actions}
        </div>
      )}
      {caption && <p className="px-0.5 pt-1.5 text-xs text-[var(--muted)]">{caption}</p>}
      <ConfirmDialog
        open={confirmDelete && editable}
        title={removeTitle}
        message={removeMessage}
        confirmLabel={removeTitle}
        onCancel={() => setConfirmDelete(false)}
        onConfirm={() => {
          if (!editor.isEditable) return;
          try {
            editor.removeBlocks([blockId]);
            setConfirmDelete(false);
          } catch {
            toast.error(removeErrorToast);
          }
        }}
      />
    </div>
  );
}

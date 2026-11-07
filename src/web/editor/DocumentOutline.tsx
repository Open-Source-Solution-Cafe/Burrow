import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { BlockNoteEditor } from '@blocknote/core';
import { ListTree, X } from 'lucide-react';
import { Button } from '../components/ui/Button';
import { StatusDiamond } from '../components/ui/StatusDiamond';
import { useTranslation } from '../lib/i18n';

interface HeadingEntry {
  id: string;
  level: number;
  text: string;
}

interface DocumentOutlineProps {
  editor: BlockNoteEditor<any, any, any>;
  /** Scroll container that owns the editor DOM (used for data-id lookups). */
  containerRef: React.RefObject<HTMLDivElement | null>;
  variant?: 'floating' | 'inline';
}

function inlineText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .map((item) => {
      if (typeof item === 'string') return item;
      if (item && typeof item === 'object') {
        const rec = item as Record<string, unknown>;
        if (typeof rec.text === 'string') return rec.text;
        if (Array.isArray(rec.content)) return inlineText(rec.content);
        if (rec.type === 'mention') {
          const props = rec.props as Record<string, unknown> | undefined;
          return typeof props?.label === 'string' ? props.label : '';
        }
      }
      return '';
    })
    .join('');
}

function collectHeadings(blocks: unknown[], out: HeadingEntry[]) {
  for (const raw of blocks) {
    if (!raw || typeof raw !== 'object') continue;
    const block = raw as Record<string, unknown>;
    if (block.type === 'heading' && typeof block.id === 'string') {
      const props = block.props as Record<string, unknown> | undefined;
      const level = typeof props?.level === 'number' ? props.level : 1;
      out.push({ id: block.id, level, text: inlineText(block.content).trim() || 'Untitled' });
    }
    if (Array.isArray(block.children)) collectHeadings(block.children, out);
  }
}

/**
 * Floating or inline table of contents: extracts heading blocks, smooth-scrolls to them
 * on click, and highlights the section currently in view.
 */
export function DocumentOutline({
  editor,
  containerRef,
  variant = 'floating',
}: DocumentOutlineProps) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const [headings, setHeadings] = useState<HeadingEntry[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const observerRef = useRef<IntersectionObserver | null>(null);

  const refresh = useCallback(() => {
    const out: HeadingEntry[] = [];
    collectHeadings(editor.document, out);
    setHeadings(out);
    setActiveId((prev) => {
      const first = out[0];
      if (!first) return null;
      if (prev && out.some((h) => h.id === prev)) return prev;
      return first.id;
    });
  }, [editor]);

  // Recompute outline whenever the document changes.
  useEffect(() => {
    refresh();
    const unbind = editor.onChange(refresh);
    return unbind;
  }, [editor, refresh]);

  // Highlight the active section while scrolling.
  useEffect(() => {
    if ((!open && variant !== 'inline') || headings.length === 0) return;
    const root = containerRef.current;
    if (!root) return;

    const elements: HTMLElement[] = [];
    for (const heading of headings) {
      const el = root.querySelector<HTMLElement>('[data-id="' + CSS.escape(heading.id) + '"]');
      if (el) elements.push(el);
    }
    if (elements.length === 0) return;

    let best: { id: string; top: number } | null = null;
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          const el = entry.target as HTMLElement;
          const id = el.getAttribute('data-id');
          if (!id) continue;
          if (entry.isIntersecting) {
            const top = entry.boundingClientRect.top;
            if (!best || top < best.top) best = { id, top };
          }
        }
        if (best) setActiveId(best.id);
      },
      { root: null, rootMargin: '-72px 0px -60% 0px', threshold: [0, 1] },
    );
    for (const el of elements) observer.observe(el);
    observerRef.current = observer;
    return () => observer.disconnect();
  }, [open, variant, headings, containerRef]);

  const scrollTo = (heading: HeadingEntry) => {
    const root = containerRef.current;
    const el = root?.querySelector<HTMLElement>('[data-id="' + CSS.escape(heading.id) + '"]');
    if (el) {
      el.scrollIntoView({ behavior: 'smooth', block: 'start' });
      setActiveId(heading.id);
    }
  };

  const handleSelectHeading = (heading: HeadingEntry) => {
    scrollTo(heading);
    if (typeof window !== 'undefined' && window.innerWidth < 640) {
      setOpen(false);
    }
  };

  const ordered = useMemo(() => headings, [headings]);

  if (variant === 'inline') {
    const effectiveActiveId = activeId ?? ordered[0]?.id ?? null;
    return (
      <div className="no-print w-32 shrink-0 pt-2 text-xs select-none">
        <div className="font-eyebrow mb-2">{t('editor.onThisPage')}</div>
        {ordered.length === 0 ? (
          <div className="text-[11px] text-[var(--ink-muted)]/70 py-1">{t('editor.noHeadings')}</div>
        ) : (
          <nav className="flex flex-col">
            {ordered.map((heading) => {
              const isActive = effectiveActiveId === heading.id;
              return (
                <button
                  key={heading.id}
                  type="button"
                  onClick={() => scrollTo(heading)}
                  className={`flex items-center gap-2 py-1.5 text-left text-[12px] transition cursor-pointer truncate ${
                    isActive
                      ? 'text-[var(--text)] font-bold'
                      : 'text-[var(--ink-muted)] font-medium hover:text-[var(--text)]'
                  }`}
                >
                  <span className="w-[7px] flex shrink-0">
                    {isActive && <span className="diamond-dot" />}
                  </span>
                  <span className="truncate">{heading.text}</span>
                </button>
              );
            })}
          </nav>
        )}
      </div>
    );
  }

  return (
    <div className="no-print relative">
      {/* Toggle button */}
      <Button
        variant="ghost"
        onClick={() => setOpen((v) => !v)}
        title={open ? t('editor.hideOutline') : t('editor.showOutline')}
        className={`p-2 sm:p-1.5 min-w-[44px] min-h-[44px] sm:min-w-0 sm:min-h-0 border flex items-center justify-center transition cursor-pointer ${
          open
            ? 'text-[var(--accent-ink)] bg-[var(--accent)] border-[var(--accent)]'
            : 'text-[var(--muted)] border-[var(--line)] hover:text-[var(--text)]'
        }`}
      >
        <ListTree className="w-4 h-4" />
      </Button>

      {/* Floating outline panel — responsive bottom sheet on mobile, angular Basalt surface on desktop */}
      {open && (
        <>
          <div
            onClick={() => setOpen(false)}
            className="fixed inset-0 z-30 bg-black/40 sm:hidden"
          />
          <div className="fixed inset-x-3 bottom-4 max-h-[60vh] sm:static sm:inset-x-auto sm:bottom-auto sm:max-h-none sm:absolute sm:right-0 sm:top-full sm:mt-2 sm:w-64 sm:max-h-[70vh] overflow-y-auto bg-[var(--surface)] border border-[var(--line)] z-40 p-3 sm:p-2 chamfer-md">
            <div className="flex items-center justify-between px-2 py-1.5 mb-1">
              <span className="text-[11px] sm:text-[10px] font-semibold uppercase tracking-wider text-[var(--muted)]">
                {t('editor.onThisPage')}
              </span>
              <button
                onClick={() => setOpen(false)}
                className="p-1 min-w-[44px] min-h-[44px] sm:min-w-0 sm:min-h-0 flex items-center justify-center text-[var(--muted)] hover:text-[var(--text)] cursor-pointer"
                aria-label={t('editor.closeOutline')}
              >
                <X className="w-4 h-4 sm:w-3 sm:h-3" />
              </button>
            </div>

            {ordered.length === 0 ? (
              <div className="px-2 py-3 text-xs text-[var(--muted)] italic">
                {t('editor.noHeadingsYet')}
              </div>
            ) : (
              <nav className="space-y-0.5">
                {ordered.map((heading) => (
                  <button
                    key={heading.id}
                    onClick={() => handleSelectHeading(heading)}
                    className={`w-full text-left px-2.5 py-2 sm:px-2 sm:py-1 min-h-[44px] sm:min-h-0 text-xs transition truncate flex items-center gap-2 cursor-pointer ${
                      activeId === heading.id
                        ? 'bg-[var(--accent)] text-[var(--accent-ink)] font-medium'
                        : 'text-[var(--muted)] hover:bg-[var(--hi)] hover:text-[var(--text)]'
                    }`}
                    style={{ paddingLeft: `${10 + (heading.level - 1) * 12}px` }}
                  >
                    <StatusDiamond
                      color={activeId === heading.id ? 'var(--accent-ink)' : 'var(--muted)'}
                      size={6}
                    />
                    <span className="truncate">{heading.text}</span>
                  </button>
                ))}
              </nav>
            )}
          </div>
        </>
      )}
    </div>
  );
}

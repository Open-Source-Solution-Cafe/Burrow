import { useCallback, useEffect, useRef, useState } from 'react';
import type { KeyboardEvent as ReactKeyboardEvent, MouseEvent as ReactMouseEvent } from 'react';

export interface UseResizableWidthOptions {
  storageKey: string;
  defaultWidth: number;
  minWidth: number;
  maxWidth: number;
  step?: number;
}

/** Clamp a sidebar width to its allowed `[minWidth, maxWidth]` bounds. */
export function clampWidth(value: number, minWidth: number, maxWidth: number): number {
  return Math.max(minWidth, Math.min(maxWidth, value));
}

/** Read and clamp a persisted sidebar width from `localStorage`, falling back to `defaultWidth`. */
export function readStoredWidth(
  storageKey: string,
  defaultWidth: number,
  minWidth: number,
  maxWidth: number,
): number {
  if (typeof window === 'undefined') return defaultWidth;
  try {
    const saved = localStorage.getItem(storageKey);
    if (saved) {
      const parsed = parseInt(saved, 10);
      if (!Number.isNaN(parsed)) {
        return clampWidth(parsed, minWidth, maxWidth);
      }
    }
  } catch {
    /* ignore storage errors */
  }
  return defaultWidth;
}

/** Persist a sidebar width to `localStorage`, ignoring storage failures. */
export function persistWidth(storageKey: string, width: number): void {
  try {
    localStorage.setItem(storageKey, String(width));
  } catch {
    /* ignore storage errors */
  }
}

/** Manage drag- and keyboard-resizable sidebar panel width with `localStorage` persistence. */
export function useResizableWidth({
  storageKey,
  defaultWidth,
  minWidth,
  maxWidth,
  step = 16,
}: UseResizableWidthOptions) {
  const [width, setWidth] = useState<number>(() =>
    readStoredWidth(storageKey, defaultWidth, minWidth, maxWidth),
  );
  const [isResizing, setIsResizing] = useState(false);
  const dragRef = useRef<{ startX: number; startWidth: number } | null>(null);
  const latestWidthRef = useRef(width);
  latestWidthRef.current = width;

  useEffect(() => {
    if (!isResizing) return;

    const handleMouseMove = (e: MouseEvent) => {
      if (!dragRef.current) return;
      const delta = e.clientX - dragRef.current.startX;
      const next = clampWidth(dragRef.current.startWidth + delta, minWidth, maxWidth);
      latestWidthRef.current = next;
      setWidth(next);
    };

    const handleMouseUp = () => {
      setIsResizing(false);
      dragRef.current = null;
      persistWidth(storageKey, latestWidthRef.current);
    };

    window.addEventListener('mousemove', handleMouseMove);
    window.addEventListener('mouseup', handleMouseUp);
    return () => {
      window.removeEventListener('mousemove', handleMouseMove);
      window.removeEventListener('mouseup', handleMouseUp);
    };
  }, [isResizing, maxWidth, minWidth, storageKey]);

  const startResize = useCallback((e: ReactMouseEvent) => {
    e.preventDefault();
    dragRef.current = { startX: e.clientX, startWidth: latestWidthRef.current };
    setIsResizing(true);
  }, []);

  const resetWidth = useCallback(() => {
    latestWidthRef.current = defaultWidth;
    setWidth(defaultWidth);
    persistWidth(storageKey, defaultWidth);
  }, [defaultWidth, storageKey]);

  const handleKeyDown = useCallback(
    (e: ReactKeyboardEvent) => {
      let next: number | null = null;
      if (e.key === 'ArrowLeft') {
        next = clampWidth(latestWidthRef.current - step, minWidth, maxWidth);
      } else if (e.key === 'ArrowRight') {
        next = clampWidth(latestWidthRef.current + step, minWidth, maxWidth);
      } else if (e.key === 'Home') {
        next = minWidth;
      } else if (e.key === 'End') {
        next = maxWidth;
      } else if (e.key === 'Enter' || e.key === ' ') {
        next = defaultWidth;
      }
      if (next !== null) {
        e.preventDefault();
        latestWidthRef.current = next;
        setWidth(next);
        persistWidth(storageKey, next);
      }
    },
    [defaultWidth, maxWidth, minWidth, step, storageKey],
  );

  return {
    width,
    isResizing,
    startResize,
    resetWidth,
    handleKeyDown,
  };
}

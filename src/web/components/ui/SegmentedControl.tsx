import * as React from 'react';
import { cn } from '../../lib/utils';

export interface SegmentOption {
  value: string;
  label: React.ReactNode;
}

export interface SegmentedControlProps {
  value: string;
  onValueChange: (value: string) => void;
  options: SegmentOption[];
  size?: 'sm' | 'md';
  fullWidth?: boolean;
  className?: string;
  ariaLabel?: string;
}

/** Angular segmented control — selected tab gets sulfur-yellow accent. */
export function SegmentedControl({
  value,
  onValueChange,
  options,
  size = 'md',
  fullWidth = false,
  className,
  ariaLabel,
}: SegmentedControlProps) {
  return (
    <div
      role="tablist"
      aria-label={ariaLabel}
      className={cn(
        'inline-flex items-center gap-0.5 border border-[var(--line)] bg-[var(--surface2)] p-0.5',
        fullWidth && 'flex w-full',
        className,
      )}
    >
      {options.map((opt) => {
        const active = opt.value === value;
        return (
          <button
            key={opt.value}
            role="tab"
            aria-selected={active}
            type="button"
            onClick={() => onValueChange(opt.value)}
            className={cn(
              'inline-flex h-8 items-center justify-center gap-1 sm:gap-1.5 px-2.5 sm:px-3 text-[11px] sm:text-[12px] font-bold uppercase tracking-[0.05em] transition-colors',
              size === 'sm' && 'h-7 px-2 text-[10px] sm:text-[11px]',
              fullWidth && 'flex-1 px-1 sm:px-2.5',
              active
                ? 'bg-[var(--accent)] text-[var(--accent-ink)]'
                : 'bg-transparent text-[var(--muted)] hover:bg-[var(--hi)] hover:text-[var(--hi-ink)]',
            )}
          >
            {opt.label}
          </button>
        );
      })}
    </div>
  );
}

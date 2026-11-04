import * as React from 'react';
import { cn } from '../../lib/utils';

export interface SelectProps extends React.SelectHTMLAttributes<HTMLSelectElement> {
  sizeVariant?: 'sm' | 'md' | 'lg';
}

const selectSizes: Record<'sm' | 'md' | 'lg', string> = {
  sm: 'h-7 px-2 py-0.5 text-[11px]',
  md: 'h-8 px-2.5 py-1 text-xs font-medium',
  lg: 'h-10 px-3 py-2 text-sm',
};

export const Select = React.forwardRef<HTMLSelectElement, SelectProps>(
  ({ className, sizeVariant = 'md', children, ...props }, ref) => (
    <select
      ref={ref}
      className={cn(
        'w-full border border-[var(--line)] bg-[var(--surface)] text-[var(--text)] focus:border-[var(--accent)] focus:outline-none transition-colors cursor-pointer [&_option]:bg-[var(--surface)] [&_option]:text-[var(--text)] [&_option]:text-xs',
        selectSizes[sizeVariant],
        className,
      )}
      {...props}
    >
      {children}
    </select>
  ),
);
Select.displayName = 'Select';

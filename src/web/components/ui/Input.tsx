import * as React from 'react';
import { cn } from '../../lib/utils';

export interface InputProps extends React.InputHTMLAttributes<HTMLInputElement> {
  sizeVariant?: 'sm' | 'md' | 'lg';
}

const inputSizes: Record<'sm' | 'md' | 'lg', string> = {
  sm: 'h-7 px-2 py-0.5 text-[11px]',
  md: 'h-8 px-2.5 py-1 text-xs',
  lg: 'h-10 px-3 py-2 text-sm',
};

export const Input = React.forwardRef<HTMLInputElement, InputProps>(
  ({ className, sizeVariant = 'md', type = 'text', ...props }, ref) => (
    <input
      ref={ref}
      type={type}
      className={cn(
        'w-full border border-[var(--line)] bg-[var(--surface)] text-[var(--text)] placeholder:text-[var(--muted)] focus:border-[var(--accent)] focus:outline-none transition-colors',
        inputSizes[sizeVariant],
        className,
      )}
      {...props}
    />
  ),
);
Input.displayName = 'Input';

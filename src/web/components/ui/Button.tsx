import * as React from 'react';
import { cva, type VariantProps } from 'class-variance-authority';
import { cn } from '../../lib/utils';

const buttonVariants = cva(
  'chamfer-sm inline-flex items-center justify-center gap-2 px-3 font-display font-extrabold uppercase tracking-[0.04em] transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--accent)] focus-visible:[clip-path:none] disabled:pointer-events-none disabled:opacity-50 [&_svg]:shrink-0',
  {
    variants: {
      variant: {
        primary:
          'bg-[var(--accent)] text-[var(--accent-ink)] hover:brightness-110 active:brightness-95',
        secondary:
          'bg-[var(--surface)] text-[var(--text)] border border-[var(--line)] hover:bg-[var(--hi)] hover:text-[var(--hi-ink)]',
        ghost: 'bg-transparent text-[var(--text)] hover:bg-[var(--hi)] hover:text-[var(--hi-ink)]',
        danger:
          'bg-transparent text-[var(--danger)] border border-[var(--danger)] hover:bg-[var(--danger)] hover:text-[var(--danger-ink)]',
      },
      size: {
        sm: 'h-7 min-h-0 px-2 py-1 text-[11px] [&_svg]:size-3.5',
        md: 'h-8 min-h-0 px-3 py-1 text-xs [&_svg]:size-3.5',
        lg: 'h-9 min-h-0 px-4 py-1.5 text-xs sm:text-sm [&_svg]:size-4',
        icon: 'px-0 w-8 h-8 min-h-0 [&_svg]:size-4',
      },
    },
    defaultVariants: { variant: 'primary', size: 'md' },
  },
);

export interface ButtonProps
  extends React.ButtonHTMLAttributes<HTMLButtonElement>, VariantProps<typeof buttonVariants> {}

export const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant, size, type = 'button', ...props }, ref) => (
    <button
      ref={ref}
      type={type}
      className={cn(buttonVariants({ variant, size }), className)}
      {...props}
    />
  ),
);
Button.displayName = 'Button';

export { buttonVariants };

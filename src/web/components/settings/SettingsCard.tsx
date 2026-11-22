import { useEffect, type ReactNode } from 'react';

export const ICON_PRESETS = ['📁', '🚀', '⚡', '🎯', '🛠️', '💡', '📊', '📝', '📦', '✨'] as const;
export const COLOR_PRESETS = [
  '#6366f1',
  '#059669',
  '#d97706',
  '#dc2626',
  '#9333ea',
  '#0284c7',
  '#64748b',
] as const;

export function SettingsPageShell({ children }: { children: ReactNode }) {
  return (
    <div className="flex-1 overflow-y-auto">
      <div className="max-w-4xl mx-auto py-5 px-3.5 sm:py-8 sm:px-6 space-y-5 sm:space-y-8">
        {children}
      </div>
    </div>
  );
}

export function SettingsCard({ id, children }: { id?: string; children: ReactNode }) {
  return (
    <div
      id={id}
      className="chamfer-sm border border-[var(--line)] bg-[var(--surface)] p-4 sm:p-5 space-y-4"
    >
      {children}
    </div>
  );
}

export function SettingsCardHeader({
  icon,
  title,
  actions,
}: {
  icon: ReactNode;
  title: string;
  actions?: ReactNode;
}) {
  return (
    <div className="flex items-center justify-between gap-4 border-b border-[var(--hair)] pb-3 flex-wrap">
      <div className="flex items-center gap-2">
        {icon}
        <h2 className="text-xs font-semibold uppercase tracking-wider text-[var(--text)]">
          {title}
        </h2>
      </div>
      {actions}
    </div>
  );
}

export function useScrollToHash(hash: string | undefined, ready = true) {
  useEffect(() => {
    if (!ready) return;
    const rawHash = hash || (typeof window !== 'undefined' ? window.location.hash : '');
    const targetId = rawHash.replace(/^#/, '').toLowerCase();
    if (!targetId || typeof document === 'undefined') return;
    requestAnimationFrame(() => {
      document.getElementById(targetId)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    });
  }, [hash, ready]);
}

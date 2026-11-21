import { useEffect } from 'react';
import { SlidersHorizontal } from 'lucide-react';
import { toast } from 'sonner';
import { useFeatureFlags, useUpdateFeatureFlags } from '../../lib/queries';
import { Badge } from '../ui/Badge';

export function FeatureFlagsSection({
  workspaceId,
  isOwner,
}: {
  workspaceId: string;
  isOwner: boolean;
}) {
  const { data, isLoading } = useFeatureFlags(workspaceId);
  const updateFlags = useUpdateFeatureFlags(workspaceId);

  useEffect(() => {
    if (!isLoading && data && typeof window !== 'undefined' && window.location.hash === '#features') {
      document.getElementById('features')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }
  }, [isLoading, data]);

  if (isLoading || !data) {
    return null;
  }

  return (
    <div
      id="features"
      className="scroll-mt-4 chamfer-sm border border-[var(--line)] bg-[var(--surface)] p-4 sm:p-5 space-y-4"
    >
      <div className="flex items-center justify-between gap-2 border-b border-[var(--hair)] pb-3">
        <div className="flex items-center gap-2">
          <SlidersHorizontal className="w-4 h-4 text-[var(--accent)]" />
          <h2 className="text-xs font-semibold uppercase tracking-wider text-[var(--text)]">
            Features &amp; Labs
          </h2>
        </div>
        <Badge className="text-[10px] font-mono uppercase">
          {isOwner ? 'Owner Controls' : 'Read-Only'}
        </Badge>
      </div>

      <p className="text-xs text-[var(--muted)]">
        New capabilities ship dormant by default. Turn on only the features your workspace needs.
        To port workspace data to another instance, enable <strong>Instance Data Migration</strong>{' '}
        first.
      </p>

      <div className="divide-y divide-[var(--hair)]">
        {data.definitions.map((def) => {
          const enabled = Boolean(data.flags[def.key]);
          const locked = data.lockedKeys.includes(def.key);
          const disabled = !isOwner || locked || updateFlags.isPending;

          return (
            <div
              key={def.key}
              className="py-3 first:pt-1 last:pb-1 flex items-start justify-between gap-4"
            >
              <div className="space-y-0.5 min-w-0">
                <div className="flex items-center gap-2 flex-wrap">
                  <span className="text-xs font-semibold text-[var(--text)]">{def.label}</span>
                  <span className="text-[10px] font-mono px-1.5 py-0.5 border border-[var(--line)] bg-[var(--surface2)] text-[var(--muted)]">
                    {def.key}
                  </span>
                  {locked && (
                    <Badge className="text-[10px] uppercase font-mono">Managed by Instance</Badge>
                  )}
                </div>
                <p className="text-xs text-[var(--muted)]">{def.description}</p>
              </div>

              <button
                type="button"
                role="switch"
                aria-checked={enabled}
                aria-label={`Toggle ${def.label}`}
                disabled={disabled}
                onClick={async () => {
                  try {
                    await updateFlags.mutateAsync({ [def.key]: !enabled });
                    toast.success(`${def.label} ${!enabled ? 'enabled' : 'disabled'}`);
                  } catch {
                    /* mutation handles error toast */
                  }
                }}
                className={`relative inline-flex h-5 w-9 shrink-0 items-center border transition cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed ${
                  enabled
                    ? 'bg-[var(--accent)] border-[var(--accent)]'
                    : 'bg-[var(--surface2)] border-[var(--line)]'
                }`}
              >
                <span
                  className={`inline-block h-3.5 w-3.5 transform bg-[var(--surface)] border border-[var(--line)] transition ${
                    enabled ? 'translate-x-4' : 'translate-x-0.5'
                  }`}
                />
              </button>
            </div>
          );
        })}
      </div>
    </div>
  );
}

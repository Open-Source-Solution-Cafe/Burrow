import { useState } from 'react';
import { Globe, KeyRound, Plug, ShieldAlert } from 'lucide-react';
import { toast } from 'sonner';
import { useInstalledPlugins, useTogglePlugin, type InstalledPluginInfo } from '../../lib/queries';
import { Badge } from '../ui/Badge';
import { Button } from '../ui/Button';
import { ConfirmDialog } from '../ui/ConfirmDialog';

export function PluginsSection({ isOwner }: { isOwner: boolean }) {
  const { data, isLoading } = useInstalledPlugins();
  const togglePlugin = useTogglePlugin();
  const [pendingConsent, setPendingConsent] = useState<InstalledPluginInfo | null>(null);

  if (isLoading || !data) {
    return null;
  }

  const plugins = data.plugins ?? [];

  const handleEnableConfirmed = async () => {
    if (!pendingConsent) return;
    await togglePlugin.mutateAsync({
      pluginId: pendingConsent.id,
      enabled: true,
      consentAccepted: true,
    });
    toast.success(`${pendingConsent.name} enabled`);
    setPendingConsent(null);
  };

  return (
    <div
      id="plugins"
      className="scroll-mt-4 chamfer-sm border border-[var(--line)] bg-[var(--surface)] p-4 sm:p-5 space-y-4"
    >
      <div className="flex items-center justify-between gap-2 border-b border-[var(--hair)] pb-3">
        <div className="flex items-center gap-2">
          <Plug className="w-4 h-4 text-[var(--accent)]" />
          <h2 className="text-xs font-semibold uppercase tracking-wider text-[var(--text)]">
            Installed Plugins
          </h2>
        </div>
        <Badge className="text-[10px] font-mono uppercase">
          {plugins.length} Loaded
        </Badge>
      </div>

      <p className="text-xs text-[var(--muted)]">
        Installed plugins declare their required permissions, outbound network allowlist, and
        configuration keys below.
      </p>

      {plugins.length === 0 ? (
        <div className="text-xs font-mono text-[var(--muted)] py-2">
          No plugins installed on this instance.
        </div>
      ) : (
        <div className="divide-y divide-[var(--hair)]">
          {plugins.map((plugin) => {
            const locked = !isOwner || plugin.instanceManaged || plugin.killSwitched;
            return (
              <div key={plugin.id} className="py-3 first:pt-1 last:pb-1 space-y-2">
                <div className="flex items-start justify-between gap-4">
                  <div className="space-y-1 min-w-0">
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="text-xs font-semibold text-[var(--text)]">{plugin.name}</span>
                      <span className="text-[10px] font-mono px-1.5 py-0.5 border border-[var(--line)] bg-[var(--surface2)] text-[var(--muted)]">
                        {plugin.id} v{plugin.version}
                      </span>
                      <Badge className="text-[10px] font-mono uppercase">
                        {plugin.killSwitched
                          ? 'Kill-Switched'
                          : plugin.enabled
                            ? 'Enabled'
                            : 'Disabled'}
                      </Badge>
                      {plugin.instanceManaged && (
                        <Badge className="text-[10px] font-mono uppercase">Managed by Instance</Badge>
                      )}
                    </div>
                    {plugin.description && (
                      <p className="text-xs text-[var(--muted)]">{plugin.description}</p>
                    )}
                    <p className="text-xs text-[var(--text)]">{plugin.consentSummary}</p>
                  </div>

                  <div className="shrink-0">
                    {plugin.enabled ? (
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        disabled={locked || togglePlugin.isPending}
                        onClick={async () => {
                          await togglePlugin.mutateAsync({ pluginId: plugin.id, enabled: false });
                          toast.success(`${plugin.name} disabled`);
                        }}
                      >
                        Disable
                      </Button>
                    ) : (
                      <Button
                        type="button"
                        variant="primary"
                        size="sm"
                        disabled={locked || togglePlugin.isPending}
                        onClick={() => setPendingConsent(plugin)}
                      >
                        Enable
                      </Button>
                    )}
                  </div>
                </div>

                <div className="flex flex-wrap gap-1.5 text-[10px] font-mono">
                  {plugin.permissions.map((perm) => (
                    <span
                      key={perm}
                      className="inline-flex items-center gap-1 px-1.5 py-0.5 border border-[var(--line)] bg-[var(--surface2)] text-[var(--muted)]"
                    >
                      <ShieldAlert className="w-2.5 h-2.5 text-[var(--accent)]" />
                      {perm}
                    </span>
                  ))}
                  {plugin.network.map((host) => (
                    <span
                      key={host}
                      className="inline-flex items-center gap-1 px-1.5 py-0.5 border border-[var(--line)] bg-[var(--surface2)] text-[var(--text)]"
                    >
                      <Globe className="w-2.5 h-2.5 text-[var(--accent)]" />
                      {host}
                    </span>
                  ))}
                  {plugin.configKeys.map((key) => (
                    <span
                      key={key}
                      className="inline-flex items-center gap-1 px-1.5 py-0.5 border border-[var(--line)] bg-[var(--surface2)] text-[var(--muted)]"
                    >
                      <KeyRound className="w-2.5 h-2.5" />
                      {key}
                    </span>
                  ))}
                </div>
              </div>
            );
          })}
        </div>
      )}

      {pendingConsent && (
        <ConfirmDialog
          open
          title={`Enable ${pendingConsent.name}?`}
          message={`${pendingConsent.consentSummary} Review its declared permissions (${pendingConsent.permissions.join(', ') || 'none'}) and network hosts (${pendingConsent.network.join(', ') || 'none'}) before enabling.`}
          confirmLabel="Confirm & Enable"
          busy={togglePlugin.isPending}
          onConfirm={handleEnableConfirmed}
          onCancel={() => setPendingConsent(null)}
        />
      )}
    </div>
  );
}

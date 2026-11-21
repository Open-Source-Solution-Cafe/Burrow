import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { ArrowUpCircle, CheckCircle2, Copy, ExternalLink, RefreshCw } from 'lucide-react';
import { toast } from 'sonner';
import { useSystemVersion, type SystemVersionInfo } from '../../lib/queries';
import { Badge } from '../ui/Badge';
import { Button } from '../ui/Button';

function upgradeCommandForRuntime(runtime?: SystemVersionInfo['runtime']): {
  label: string;
  command: string;
} {
  if (runtime === 'worker') {
    return {
      label: 'Cloudflare Workers',
      command: 'git pull origin main && pnpm install && pnpm run deploy',
    };
  }
  if (runtime === 'node-sqlite') {
    return {
      label: 'Node.js / SQLite',
      command: 'git pull origin main && pnpm install && pnpm run build && pnpm start',
    };
  }
  return {
    label: 'Docker Compose',
    command: 'git pull origin main && docker compose up -d --build',
  };
}

export function SystemUpdateSection({ isOwner }: { isOwner: boolean }) {
  const queryClient = useQueryClient();
  const { data: systemVersion, isLoading } = useSystemVersion();
  const [checking, setChecking] = useState(false);
  const [updating, setUpdating] = useState(false);

  if (isLoading || !systemVersion || !systemVersion.allowSelfUpdate) {
    return null;
  }

  const runtimeInfo = upgradeCommandForRuntime(systemVersion.runtime);
  const releaseUrl =
    systemVersion.releaseNotesUrl ||
    'https://github.com/Open-Source-Solution-Cafe/Burrow/releases';

  const handleCheckNow = async () => {
    setChecking(true);
    try {
      const res = await fetch('/api/system/version?refresh=1');
      if (!res.ok) throw new Error('Failed to check for updates');
      const fresh = (await res.json()) as SystemVersionInfo;
      queryClient.setQueryData(['system', 'version'], fresh);
      if (fresh.updateAvailable) {
        toast.info(`Update available: v${fresh.latestVersion}`);
      } else {
        toast.success(`Burrow is up to date (v${fresh.currentVersion})`);
      }
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to check for updates');
    } finally {
      setChecking(false);
    }
  };

  const handleTriggerUpdate = async () => {
    setUpdating(true);
    try {
      const res = await fetch('/api/system/update', { method: 'POST' });
      const data = (await res.json().catch(() => ({}))) as {
        message?: string;
        error?: { message?: string };
      };
      if (!res.ok) throw new Error(data.error?.message || 'Failed to trigger update');
      toast.success(data.message || 'Self-update triggered');
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to trigger update');
    } finally {
      setUpdating(false);
    }
  };

  return (
    <div className="chamfer-sm border border-[var(--line)] bg-[var(--surface)] p-4 sm:p-5 space-y-4">
      <div className="flex items-center justify-between gap-2 border-b border-[var(--hair)] pb-3 flex-wrap">
        <div className="flex items-center gap-2">
          <ArrowUpCircle className="w-4 h-4 text-[var(--accent)]" />
          <h2 className="text-xs font-semibold uppercase tracking-wider text-[var(--text)]">
            System &amp; Core Updates
          </h2>
        </div>
        {systemVersion.updateAvailable ? (
          <Badge tone="accent" className="text-[10px] font-mono uppercase">
            Update Available (v{systemVersion.latestVersion})
          </Badge>
        ) : (
          <Badge className="text-[10px] font-mono uppercase">
            <CheckCircle2 className="w-3 h-3 mr-1 inline" />
            Up to Date
          </Badge>
        )}
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 text-xs">
        <div className="p-2.5 border border-[var(--line)] bg-[var(--surface2)]">
          <div className="text-[10px] uppercase tracking-wider text-[var(--muted)]">
            Current Core
          </div>
          <div className="font-mono font-semibold text-[var(--text)] mt-0.5">
            v{systemVersion.currentVersion}
          </div>
        </div>
        <div className="p-2.5 border border-[var(--line)] bg-[var(--surface2)]">
          <div className="text-[10px] uppercase tracking-wider text-[var(--muted)]">
            Latest Core
          </div>
          <div className="font-mono font-semibold text-[var(--text)] mt-0.5">
            v{systemVersion.latestVersion}
          </div>
        </div>
        <div className="p-2.5 border border-[var(--line)] bg-[var(--surface2)]">
          <div className="text-[10px] uppercase tracking-wider text-[var(--muted)]">Runtime</div>
          <div className="font-mono font-semibold text-[var(--text)] mt-0.5">
            {runtimeInfo.label}
          </div>
        </div>
      </div>

      <div className="space-y-1.5">
        <div className="text-[11px] font-medium text-[var(--muted)]">
          Upgrade command ({runtimeInfo.label})
        </div>
        <div className="flex items-center gap-2">
          <code className="flex-1 px-2.5 py-1.5 text-xs font-mono bg-[var(--surface2)] border border-[var(--line)] text-[var(--text)] overflow-x-auto">
            {runtimeInfo.command}
          </code>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={() => {
              navigator.clipboard?.writeText(runtimeInfo.command);
              toast.success('Upgrade command copied');
            }}
            title="Copy upgrade command"
          >
            <Copy className="w-3.5 h-3.5" />
          </Button>
        </div>
      </div>

      <div className="flex items-center gap-2 flex-wrap pt-1">
        <Button
          type="button"
          variant="secondary"
          size="sm"
          disabled={checking}
          onClick={handleCheckNow}
          className="flex items-center gap-1.5"
        >
          <RefreshCw className={`w-3.5 h-3.5 ${checking ? 'animate-spin' : ''}`} />
          <span>{checking ? 'Checking…' : 'Check for Updates'}</span>
        </Button>

        <a
          href={releaseUrl}
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium border border-[var(--line)] text-[var(--text)] hover:bg-[var(--hi)] transition"
        >
          <span>Release Notes</span>
          <ExternalLink className="w-3 h-3" />
        </a>

        {systemVersion.webhookConfigured && systemVersion.updateAvailable && isOwner && (
          <Button
            type="button"
            variant="primary"
            size="sm"
            disabled={updating}
            onClick={handleTriggerUpdate}
          >
            {updating ? 'Triggering…' : 'Trigger Self-Update'}
          </Button>
        )}
      </div>
    </div>
  );
}

import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import {
  ArrowUpCircle,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  Copy,
  ExternalLink,
  RefreshCw,
  Rocket,
} from 'lucide-react';
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
      command: 'pnpm run sync:upstream && pnpm install && pnpm run deploy',
    };
  }
  if (runtime === 'node-sqlite') {
    return {
      label: 'Node.js / SQLite',
      command: 'pnpm run sync:upstream && pnpm install && pnpm run build && pnpm start',
    };
  }
  return {
    label: 'Docker Compose',
    command: 'pnpm run sync:upstream && docker compose up -d --build',
  };
}

function providerDisplayLabel(provider?: SystemVersionInfo['webhookProvider']): string | null {
  if (provider === 'gitlab') return 'GitLab CI';
  if (provider === 'github') return 'GitHub Actions';
  if (provider === 'webhook') return 'Webhook';
  return null;
}

function formatCheckedAt(iso?: string): string | null {
  if (!iso) return null;
  const parsed = new Date(iso);
  if (Number.isNaN(parsed.getTime())) return null;
  return parsed.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

export function SystemUpdateSection({ isOwner }: { isOwner: boolean }) {
  const queryClient = useQueryClient();
  const { data: systemVersion, isLoading } = useSystemVersion();
  const [checking, setChecking] = useState(false);
  const [updating, setUpdating] = useState(false);
  const [lastTriggerMessage, setLastTriggerMessage] = useState<string | null>(null);
  const [showWebhookGuide, setShowWebhookGuide] = useState(false);

  if (isLoading || !systemVersion || !systemVersion.allowSelfUpdate) {
    return null;
  }

  const runtimeInfo = upgradeCommandForRuntime(systemVersion.runtime);
  const releaseUrl =
    systemVersion.releaseNotesUrl ||
    'https://github.com/Open-Source-Solution-Cafe/Burrow/releases';
  const providerLabel = providerDisplayLabel(systemVersion.webhookProvider);
  const checkIntervalMin = systemVersion.checkIntervalMinutes ?? 60;
  const checkedAtLabel = formatCheckedAt(systemVersion.checkedAt);

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
    setLastTriggerMessage(null);
    try {
      const res = await fetch('/api/system/update', { method: 'POST' });
      const data = (await res.json().catch(() => ({}))) as {
        message?: string;
        error?: { message?: string };
      };
      if (!res.ok) throw new Error(data.error?.message || 'Failed to trigger update');
      const msg = data.message || 'Self-update triggered';
      setLastTriggerMessage(msg);
      toast.success(msg);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to trigger update');
    } finally {
      setUpdating(false);
    }
  };

  return (
    <div
      id="updates"
      className="chamfer-sm border border-[var(--line)] bg-[var(--surface)] p-4 sm:p-5 space-y-4"
    >
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
          <div
            className={`font-mono font-semibold mt-0.5 ${
              systemVersion.updateAvailable ? 'text-[var(--accent)]' : 'text-[var(--text)]'
            }`}
          >
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

      <p className="text-[11px] text-[var(--muted)]">
        Checks automatically every {checkIntervalMin} minutes while open
        {checkedAtLabel ? ` · Last checked at ${checkedAtLabel}` : ''}.
      </p>

      {lastTriggerMessage && (
        <div
          role="status"
          className="p-3 border border-[var(--accent)]/40 bg-[var(--accent)]/10 text-xs text-[var(--text)] space-y-1"
        >
          <div className="font-semibold text-[var(--accent)]">Upgrade pipeline triggered</div>
          <p className="text-[11px] text-[var(--muted)]">{lastTriggerMessage}</p>
        </div>
      )}

      <div className="space-y-1.5">
        <div className="text-[11px] font-medium text-[var(--muted)]">
          Manual upgrade command ({runtimeInfo.label})
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
        {systemVersion.webhookConfigured && isOwner && (
          <Button
            type="button"
            variant="primary"
            size="sm"
            disabled={updating}
            onClick={handleTriggerUpdate}
            className="flex items-center gap-1.5"
          >
            <Rocket className="w-3.5 h-3.5" />
            <span>
              {updating
                ? 'Triggering Upgrade…'
                : systemVersion.updateAvailable
                  ? `Upgrade to v${systemVersion.latestVersion}${providerLabel ? ` (${providerLabel})` : ''}`
                  : `Sync & Rebuild${providerLabel ? ` (${providerLabel})` : ''}`}
            </span>
          </Button>
        )}

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
      </div>

      {isOwner && !systemVersion.webhookConfigured && (
        <div className="border-t border-[var(--hair)] pt-3">
          <button
            type="button"
            onClick={() => setShowWebhookGuide((open) => !open)}
            className="flex items-center gap-1.5 text-xs font-medium text-[var(--text)] hover:text-[var(--accent)] transition cursor-pointer"
          >
            {showWebhookGuide ? (
              <ChevronDown className="w-3.5 h-3.5" />
            ) : (
              <ChevronRight className="w-3.5 h-3.5" />
            )}
            <span>Enable one-click automatic upgrades &amp; rebuilds</span>
          </button>

          {showWebhookGuide && (
            <div className="mt-2.5 p-3 border border-[var(--line)] bg-[var(--surface2)] text-[11px] text-[var(--muted)] space-y-2.5 leading-relaxed">
              <p>
                Configure <code className="font-mono text-[var(--text)]">SELF_UPDATE_WEBHOOK_URL</code>{' '}
                (and optionally{' '}
                <code className="font-mono text-[var(--text)]">SELF_UPDATE_WEBHOOK_TOKEN</code>) in
                your Cloudflare Worker Secrets or server environment to unlock the one-click{' '}
                <strong className="text-[var(--text)]">Upgrade Now</strong> button:
              </p>
              <ul className="list-disc pl-4 space-y-1.5">
                <li>
                  <strong className="text-[var(--text)]">GitLab + Cloudflare Workers Builds:</strong>{' '}
                  Burrow includes <code className="font-mono text-[var(--text)]">.gitlab-ci.yml</code>.
                  In GitLab → Settings → CI/CD, add a Project Access Token (
                  <code className="font-mono text-[var(--text)]">write_repository</code>) as{' '}
                  <code className="font-mono text-[var(--text)]">BURROW_SYNC_TOKEN</code>, create a
                  Pipeline Trigger, and set{' '}
                  <code className="font-mono text-[var(--text)]">SELF_UPDATE_WEBHOOK_URL</code> to{' '}
                  <code className="font-mono text-[var(--text)]">
                    https://gitlab.com/api/v4/projects/&lt;ID&gt;/trigger/pipeline?token=&lt;TOKEN&gt;&amp;ref=main
                  </code>
                  . Pushing the synced commit automatically triggers Cloudflare Workers Builds.
                </li>
                <li>
                  <strong className="text-[var(--text)]">GitHub + Cloudflare Workers Builds:</strong>{' '}
                  Burrow includes{' '}
                  <code className="font-mono text-[var(--text)]">.github/workflows/sync-upstream.yml</code>.
                  Create one Fine-Grained PAT (
                  <code className="font-mono text-[var(--text)]">Contents: Read and write</code> on
                  your cloned repo), save it in GitHub → Settings → Secrets → Actions as{' '}
                  <code className="font-mono text-[var(--text)]">BURROW_SYNC_TOKEN</code> (so
                  merged pushes trigger Cloudflare Workers Builds), and set{' '}
                  <code className="font-mono text-[var(--text)]">SELF_UPDATE_WEBHOOK_URL</code> to{' '}
                  <code className="font-mono text-[var(--text)]">
                    https://api.github.com/repos/&lt;OWNER&gt;/&lt;REPO&gt;/dispatches
                  </code>{' '}
                  and <code className="font-mono text-[var(--text)]">SELF_UPDATE_WEBHOOK_TOKEN</code> to
                  that same PAT in Cloudflare Worker Secrets.
                </li>
                <li>
                  <strong className="text-[var(--text)]">Docker / Self-Hosted Server:</strong> Point{' '}
                  <code className="font-mono text-[var(--text)]">SELF_UPDATE_WEBHOOK_URL</code> at your
                  container host or Watchtower deploy webhook (with optional Bearer{' '}
                  <code className="font-mono text-[var(--text)]">SELF_UPDATE_WEBHOOK_TOKEN</code>).
                </li>
              </ul>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

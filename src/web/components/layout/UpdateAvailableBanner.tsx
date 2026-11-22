import { useState } from 'react';
import { Link, useParams } from '@tanstack/react-router';
import { ArrowUpCircle, ExternalLink, X } from 'lucide-react';
import { toast } from 'sonner';
import { useAccount, useSystemVersion } from '../../lib/queries';
import { workspaceSettingsTarget } from '../../lib/workspaceRoutes';
import { Button } from '../ui/Button';

const DISMISS_PREFIX = 'burrow-dismissed-update:';

function readDismissedVersion(version: string): boolean {
  try {
    return localStorage.getItem(`${DISMISS_PREFIX}${version}`) === '1';
  } catch {
    return false;
  }
}

export function UpdateAvailableBanner() {
  const { workspaceId: routeWorkspaceId } = useParams({ strict: false });
  const { data: account } = useAccount();
  const { data: systemVersion } = useSystemVersion();
  const [dismissedVersion, setDismissedVersion] = useState<string | null>(null);
  const [triggering, setTriggering] = useState(false);

  if (!systemVersion?.updateAvailable || !systemVersion.allowSelfUpdate) {
    return null;
  }

  const activeWorkspace =
    account?.workspaces.find((w) => w.id === routeWorkspaceId) ?? account?.workspaces[0];
  const isOwner = Boolean(
    activeWorkspace?.role === 'owner' || account?.workspaces.some((w) => w.role === 'owner'),
  );
  if (!isOwner) {
    return null;
  }

  const latest = systemVersion.latestVersion;
  if (dismissedVersion === latest || readDismissedVersion(latest)) {
    return null;
  }

  const targetWorkspaceId = activeWorkspace?.id;
  const releaseUrl =
    systemVersion.releaseNotesUrl ||
    'https://github.com/Open-Source-Solution-Cafe/Burrow/releases';

  const handleDismiss = () => {
    try {
      localStorage.setItem(`${DISMISS_PREFIX}${latest}`, '1');
    } catch {
      // ignore storage errors
    }
    setDismissedVersion(latest);
  };

  const handleUpgradeNow = async () => {
    setTriggering(true);
    try {
      const res = await fetch('/api/system/update', { method: 'POST' });
      const data = (await res.json().catch(() => ({}))) as {
        message?: string;
        error?: { message?: string };
      };
      if (!res.ok) throw new Error(data.error?.message || 'Failed to trigger update');
      toast.success(data.message || 'Upgrade triggered');
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to trigger update');
    } finally {
      setTriggering(false);
    }
  };

  return (
    <div
      role="status"
      aria-live="polite"
      className="shrink-0 border-b border-[var(--accent)]/35 bg-[var(--accent)]/12 px-3 sm:px-4 py-2 text-xs text-[var(--text)] flex items-center justify-between gap-3 flex-wrap"
    >
      <div className="flex items-center gap-2 min-w-0">
        <ArrowUpCircle className="w-4 h-4 text-[var(--accent)] shrink-0" />
        <span className="font-medium">
          Burrow <span className="font-mono font-semibold text-[var(--accent)]">v{latest}</span> is
          available
        </span>
        <span className="hidden sm:inline text-[var(--muted)] font-mono text-[11px]">
          (running v{systemVersion.currentVersion})
        </span>
      </div>

      <div className="flex items-center gap-2 shrink-0">
        {systemVersion.webhookConfigured && (
          <Button
            type="button"
            variant="primary"
            size="sm"
            disabled={triggering}
            onClick={handleUpgradeNow}
            className="h-7 px-2.5 text-[11px]"
          >
            {triggering ? 'Upgrading…' : 'Upgrade Now'}
          </Button>
        )}

        {targetWorkspaceId && (
          <Link
            {...workspaceSettingsTarget(targetWorkspaceId)}
            hash="updates"
            className="inline-flex items-center gap-1 h-7 px-2.5 text-[11px] font-medium border border-[var(--accent)]/40 text-[var(--text)] hover:bg-[var(--accent)]/20 theme-radius-xs transition"
          >
            <span>{systemVersion.webhookConfigured ? 'Update Settings' : 'How to Upgrade'}</span>
          </Link>
        )}

        <a
          href={releaseUrl}
          target="_blank"
          rel="noopener noreferrer"
          className="hidden sm:inline-flex items-center gap-1 h-7 px-2 text-[11px] text-[var(--muted)] hover:text-[var(--text)] transition"
        >
          <span>Notes</span>
          <ExternalLink className="w-3 h-3" />
        </a>

        <button
          type="button"
          onClick={handleDismiss}
          className="h-7 w-7 inline-flex items-center justify-center text-[var(--muted)] hover:text-[var(--text)] hover:bg-[var(--hi)] theme-radius-xs transition cursor-pointer"
          aria-label="Dismiss update notification"
          title="Dismiss for this version"
        >
          <X className="w-3.5 h-3.5" />
        </button>
      </div>
    </div>
  );
}

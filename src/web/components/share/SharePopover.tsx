import { useEffect, useRef, useState } from 'react';
import { Link } from '@tanstack/react-router';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Copy, Globe, Link2, RefreshCw, Share2 } from 'lucide-react';
import { toast } from 'sonner';
import { useAccount, useFeatureFlags } from '../../lib/queries';
import { workspaceSettingsTarget } from '../../lib/workspaceRoutes';
import { Button } from '../ui/Button';

interface ShareStatus {
  shared: boolean;
  token?: string;
  url?: string;
  createdAt?: number;
  expiresAt?: number | null;
}

export function SharePopover({
  workspaceId,
  projectId,
  kind,
  targetId,
  title,
}: {
  workspaceId: string;
  projectId: string;
  kind: 'notepad' | 'board';
  targetId: string;
  title: string;
}) {
  const queryClient = useQueryClient();
  const { data: account } = useAccount();
  const { data: flagsData } = useFeatureFlags(workspaceId);
  const publicSharingEnabled = Boolean(flagsData?.flags?.publicSharing);
  const role = account?.workspaces.find((w) => w.id === workspaceId)?.role;
  const canManage = role === 'owner' || role === 'editor';

  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

  const shareQueryKey = ['public-share', workspaceId, projectId, kind, targetId] as const;
  const { data: status } = useQuery({
    queryKey: shareQueryKey,
    queryFn: async () => {
      const res = await fetch(
        `/api/workspaces/${encodeURIComponent(workspaceId)}/projects/${encodeURIComponent(projectId)}/shares/${kind}/${encodeURIComponent(targetId)}`,
      );
      if (!res.ok) return { shared: false } as ShareStatus;
      return (await res.json()) as ShareStatus;
    },
    enabled: publicSharingEnabled,
    staleTime: 15_000,
  });

  useEffect(() => {
    if (!open) return;
    const onOutside = (e: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener('mousedown', onOutside);
    return () => document.removeEventListener('mousedown', onOutside);
  }, [open]);

  const togglePublish = async (nextPublish: boolean, regenerate = false) => {
    setBusy(true);
    try {
      const url = `/api/workspaces/${encodeURIComponent(workspaceId)}/projects/${encodeURIComponent(projectId)}/shares/${kind}/${encodeURIComponent(targetId)}`;
      const res = await fetch(url, {
        method: nextPublish ? 'POST' : 'DELETE',
        headers: nextPublish ? { 'Content-Type': 'application/json' } : undefined,
        body: nextPublish ? JSON.stringify({ regenerate }) : undefined,
      });
      if (!res.ok) {
        const err = (await res.json().catch(() => ({}))) as { error?: { message?: string } };
        throw new Error(err.error?.message || 'Failed to update public share');
      }
      const nextStatus = (await res.json()) as ShareStatus;
      queryClient.setQueryData(shareQueryKey, nextStatus);
      if (nextPublish) {
        toast.success(regenerate ? 'Public link regenerated' : 'Published to web (read-only)');
      } else {
        toast.success('Public web access revoked');
      }
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to update share');
    } finally {
      setBusy(false);
    }
  };

  const isPublished = publicSharingEnabled && Boolean(status?.shared && status?.url);

  return (
    <div className="relative" ref={containerRef}>
      <Button
        type="button"
        variant="ghost"
        size="sm"
        onClick={() => setOpen((v) => !v)}
        className={`flex items-center gap-1.5 border px-2.5 min-h-[38px] sm:min-h-0 ${
          isPublished
            ? 'border-[var(--accent)] bg-[var(--accent)]/10 text-[var(--accent)]'
            : 'border-[var(--line)] text-[var(--muted)] hover:text-[var(--text)]'
        }`}
        title={isPublished ? 'Published to web (read-only)' : 'Share'}
      >
        {isPublished ? <Globe className="w-3.5 h-3.5" /> : <Share2 className="w-3.5 h-3.5" />}
        <span className="hidden sm:inline text-xs">{isPublished ? 'Published' : 'Share'}</span>
      </Button>

      {open && (
        <div className="absolute right-0 top-full mt-1.5 w-80 max-w-[calc(100vw-2rem)] bg-[var(--surface)] border border-[var(--line)] p-3.5 z-50 space-y-3 text-xs">
          <div className="flex items-center justify-between gap-2 pb-2 border-b border-[var(--hair)]">
            <span className="font-semibold text-[var(--text)] truncate">Share “{title}”</span>
            <button
              type="button"
              onClick={() => {
                navigator.clipboard?.writeText(window.location.href);
                toast.success('Workspace link copied');
              }}
              className="inline-flex items-center gap-1 text-[11px] text-[var(--muted)] hover:text-[var(--text)] cursor-pointer shrink-0"
            >
              <Link2 className="w-3 h-3" />
              <span>Copy internal link</span>
            </button>
          </div>

          {!publicSharingEnabled ? (
            <p className="text-[11px] leading-relaxed text-[var(--muted)]">
              Public web sharing is currently off for this workspace. Enable{' '}
              <strong>Public Read-Only Share Links</strong> in{' '}
              <Link
                {...workspaceSettingsTarget(workspaceId)}
                hash="features"
                onClick={() => setOpen(false)}
                className="text-[var(--accent)] font-semibold underline hover:opacity-80"
              >
                Workspace Settings → Features &amp; Labs
              </Link>{' '}
              to publish pages to the web.
            </p>
          ) : (
            <div className="space-y-2.5">
              <div className="flex items-center justify-between gap-3">
                <div>
                  <div className="font-semibold text-[var(--text)]">Publish to web (read-only)</div>
                  <div className="text-[11px] text-[var(--muted)]">
                    Anyone with the link can view this {kind}.
                  </div>
                </div>
                <button
                  type="button"
                  role="switch"
                  aria-checked={isPublished}
                  disabled={!canManage || busy}
                  onClick={() => void togglePublish(!isPublished)}
                  className={`relative inline-flex h-5 w-9 shrink-0 items-center border transition cursor-pointer disabled:opacity-50 ${
                    isPublished
                      ? 'bg-[var(--accent)] border-[var(--accent)]'
                      : 'bg-[var(--surface2)] border-[var(--line)]'
                  }`}
                >
                  <span
                    className={`inline-block h-3.5 w-3.5 transform bg-[var(--surface)] border border-[var(--line)] transition ${
                      isPublished ? 'translate-x-4' : 'translate-x-0.5'
                    }`}
                  />
                </button>
              </div>

              {isPublished && status?.url && (
                <div className="space-y-2 pt-1">
                  <div className="flex items-center gap-1.5">
                    <input
                      type="text"
                      readOnly
                      value={status.url}
                      className="flex-1 px-2 py-1 text-[11px] font-mono bg-[var(--surface2)] border border-[var(--line)] text-[var(--text)]"
                    />
                    <Button
                      type="button"
                      variant="primary"
                      size="sm"
                      onClick={() => {
                        navigator.clipboard?.writeText(status.url!);
                        toast.success('Public link copied');
                      }}
                    >
                      <Copy className="w-3 h-3" />
                    </Button>
                  </div>
                  <div className="flex items-center justify-between text-[11px]">
                    <span className="text-[var(--muted)]">
                      Member info &amp; comments are hidden.
                    </span>
                    {canManage && (
                      <button
                        type="button"
                        disabled={busy}
                        onClick={() => void togglePublish(true, true)}
                        className="inline-flex items-center gap-1 text-[var(--muted)] hover:text-[var(--text)] cursor-pointer"
                      >
                        <RefreshCw className="w-3 h-3" />
                        <span>Reset link</span>
                      </button>
                    )}
                  </div>
                </div>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

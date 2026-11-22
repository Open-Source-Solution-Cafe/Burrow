import { useEffect, useState } from 'react';
import { Gauge } from 'lucide-react';
import type { BurrowWebPlugin } from '@burrow/sdk';
import { ESTIMATION_MANIFEST } from './index';

const FIBONACCI_POINTS = [1, 2, 3, 5, 8, 13] as const;

function EstimatePickerModal({
  onPick,
  onClose,
}: {
  onPick: (pts: number) => void;
  onClose: () => void;
}) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
      <div className="w-full max-w-xs border border-[var(--line)] bg-[var(--surface)] p-4 theme-radius-md space-y-3">
        <div className="text-xs font-mono uppercase tracking-wider text-[var(--text)]">
          Pick Story Points
        </div>
        <div className="grid grid-cols-3 gap-2">
          {FIBONACCI_POINTS.map((pts) => (
            <button
              key={pts}
              type="button"
              onClick={() => {
                onPick(pts);
                onClose();
              }}
              className="border border-[var(--line)] bg-[var(--surface2)] py-2 text-xs font-mono text-[var(--text)] hover:bg-[var(--hi)] cursor-pointer"
            >
              {pts} pts
            </button>
          ))}
        </div>
        <button
          type="button"
          onClick={onClose}
          className="w-full border border-[var(--line)] py-1.5 text-xs font-mono text-[var(--muted)] hover:text-[var(--text)] cursor-pointer"
        >
          Cancel
        </button>
      </div>
    </div>
  );
}

function EstimationBadge({ card }: { card: Record<string, unknown> }) {
  return (
    <span className="inline-flex items-center gap-1 px-1.5 py-0.5 text-[10px] font-mono uppercase border border-[var(--line)] bg-[var(--surface2)] text-[var(--accent)]">
      <Gauge className="w-3 h-3" />
      <span>{typeof card.cardType === 'string' ? card.cardType : 'estimate'}</span>
    </span>
  );
}

function EstimationCardSection({
  card,
  workspaceId,
}: {
  card: Record<string, unknown>;
  workspaceId: string;
}) {
  const cardId = String(card.id ?? '');
  const [points, setPoints] = useState<number>(0);
  const [sprint, setSprint] = useState<string>('');
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!workspaceId || !cardId) return;
    let active = true;
    fetch(
      `/api/plugins/estimation/workspaces/${encodeURIComponent(workspaceId)}/cards/${encodeURIComponent(cardId)}`,
      { credentials: 'include' },
    )
      .then((res) => (res.ok ? res.json() : null))
      .then((data: { points?: number; sprint?: string | null } | null) => {
        if (!active || !data) return;
        setPoints(Number(data.points ?? 0));
        setSprint(data.sprint ?? '');
      })
      .catch(() => {});
    return () => {
      active = false;
    };
  }, [workspaceId, cardId]);

  const updateEstimate = async (nextPoints: number, nextSprint = sprint) => {
    setSaving(true);
    try {
      const res = await fetch(
        `/api/plugins/estimation/workspaces/${encodeURIComponent(workspaceId)}/cards/${encodeURIComponent(cardId)}`,
        {
          method: 'PUT',
          credentials: 'include',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ points: nextPoints, sprint: nextSprint || undefined }),
        },
      );
      if (res.ok) {
        setPoints(nextPoints);
      }
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="border border-[var(--hair)] bg-[var(--surface2)] p-3 space-y-2">
      <div className="flex items-center justify-between text-xs font-mono uppercase text-[var(--muted)]">
        <span>Story Points</span>
        <span className="text-[var(--text)] font-bold">{points} pts</span>
      </div>
      <div className="flex flex-wrap gap-1.5">
        {FIBONACCI_POINTS.map((pts) => (
          <button
            key={pts}
            type="button"
            disabled={saving}
            onClick={() => updateEstimate(pts)}
            className={`px-2 py-0.5 text-xs font-mono border cursor-pointer ${
              points === pts
                ? 'border-[var(--accent)] bg-[var(--accent)] text-[var(--accent-ink)]'
                : 'border-[var(--line)] bg-[var(--surface)] text-[var(--text)]'
            }`}
          >
            {pts}
          </button>
        ))}
      </div>
    </div>
  );
}

function EstimationSidebarPanel({
  workspaceId,
  projectId,
}: {
  workspaceId: string;
  projectId?: string;
}) {
  const [summary, setSummary] = useState<{ totalPoints: number; estimatedCards: number } | null>(
    null,
  );

  useEffect(() => {
    let active = true;
    const query = projectId ? `?projectId=${encodeURIComponent(projectId)}` : '';
    fetch(
      `/api/plugins/estimation/workspaces/${encodeURIComponent(workspaceId)}/summary${query}`,
      { credentials: 'include' },
    )
      .then((res) => (res.ok ? res.json() : null))
      .then((data: { totalPoints?: number; estimatedCards?: number } | null) => {
        if (!active || !data) return;
        setSummary({
          totalPoints: Number(data.totalPoints ?? 0),
          estimatedCards: Number(data.estimatedCards ?? 0),
        });
      })
      .catch(() => {});
    return () => {
      active = false;
    };
  }, [workspaceId, projectId]);

  return (
    <div className="space-y-2 border border-[var(--line)] bg-[var(--surface2)] p-3 text-xs font-mono">
      <div className="uppercase tracking-wider text-[var(--muted)]">Estimation Summary</div>
      <div className="text-sm text-[var(--text)]">
        {summary ? `${summary.totalPoints} pts across ${summary.estimatedCards} cards` : 'Loading...'}
      </div>
    </div>
  );
}

export const estimationWebPlugin: BurrowWebPlugin = {
  manifest: ESTIMATION_MANIFEST,
  slashCommands: [
    {
      id: 'estimate',
      label: 'Estimate Points',
      description: 'Insert a story point estimate tag or open point picker.',
      aliases: ['points', 'story-points', 'est'],
      group: 'Planning',
      contexts: ['notepad', 'card', 'quickadd'],
      execute(ctx) {
        if (ctx.openModal) {
          ctx.openModal((close) => (
            <EstimatePickerModal
              onPick={(pts) => ctx.insertText?.(`[${pts} pts]`)}
              onClose={close}
            />
          ));
        } else {
          ctx.insertText?.('[3 pts]');
        }
      },
    },
  ],
  mentionKinds: [
    {
      kind: 'plugin:estimation:sprint',
      group: 'Sprints',
    },
  ],
  cardTypes: [
    {
      type: 'estimate',
      label: 'Estimated Task',
      renderTileBadge: EstimationBadge,
      renderPanelSection: EstimationCardSection,
    },
  ],
  sidebarPanels: [
    {
      id: 'estimation',
      label: 'Estimation',
      icon: Gauge,
      render: EstimationSidebarPanel,
    },
  ],
};

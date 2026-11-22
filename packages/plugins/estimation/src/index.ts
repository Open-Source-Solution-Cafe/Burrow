import { Hono, type MiddlewareHandler } from 'hono';
import type { BurrowServerPlugin, PluginManifest } from '@burrow/sdk';

export const ESTIMATION_MANIFEST: PluginManifest = {
  id: 'estimation',
  name: 'Story Point Estimation & Sprints',
  version: '0.1.0',
  sdkVersion: '^0.4.0',
  permissions: ['db:own', 'routes:api', 'events:read', 'mentions:register'],
  description:
    'Community-style showcase plugin adding card point estimation, sprint @-mentions, and workspace summaries.',
};

interface EstimationPointRow {
  card_id: string;
  workspace_id: string;
  project_id: string;
  points: number;
  sprint: string | null;
  updated_at: number;
}

const DEFAULT_SPRINTS = [
  { id: 'sprint-current', label: 'Current Sprint', description: 'Active iteration' },
  { id: 'sprint-next', label: 'Next Sprint', description: 'Upcoming iteration' },
];

export const estimationServerPlugin: BurrowServerPlugin = {
  manifest: ESTIMATION_MANIFEST,
  migrations: [
    {
      name: '0001_estimation_points',
      sql: `
        CREATE TABLE IF NOT EXISTS plugin_estimation_points (
          card_id TEXT PRIMARY KEY REFERENCES cards(id) ON DELETE CASCADE,
          workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
          project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
          points INTEGER NOT NULL DEFAULT 0,
          sprint TEXT,
          updated_at INTEGER NOT NULL
        );
        --> statement-breakpoint
        CREATE INDEX IF NOT EXISTS idx_plugin_estimation_ws_project
          ON plugin_estimation_points(workspace_id, project_id);
      `,
    },
  ],
  setup(ctx) {
    const router = new Hono<any>();
    const requireIdentity = ctx.middleware.requireIdentity as MiddlewareHandler;
    const requireWorkspace = ctx.middleware.requireWorkspace as MiddlewareHandler;
    const requireEditor = ctx.middleware.requireRole('editor') as MiddlewareHandler;

    router.get('/workspaces/:wid/summary', requireIdentity, requireWorkspace, async (c) => {
      const wid = c.req.param('wid');
      const projectId = c.req.query('projectId')?.trim();
      const row = projectId
        ? await ctx.db.first<{ totalPoints: number; estimatedCards: number }>(
            `SELECT COALESCE(SUM(points), 0) AS totalPoints, COUNT(*) AS estimatedCards
             FROM plugin_estimation_points
             WHERE workspace_id = ? AND project_id = ?`,
            [wid, projectId],
          )
        : await ctx.db.first<{ totalPoints: number; estimatedCards: number }>(
            `SELECT COALESCE(SUM(points), 0) AS totalPoints, COUNT(*) AS estimatedCards
             FROM plugin_estimation_points
             WHERE workspace_id = ?`,
            [wid],
          );

      return c.json({
        workspaceId: wid,
        projectId: projectId ?? null,
        totalPoints: Number(row?.totalPoints ?? 0),
        estimatedCards: Number(row?.estimatedCards ?? 0),
      });
    });

    router.get('/workspaces/:wid/cards/:cardId', requireIdentity, requireWorkspace, async (c) => {
      const wid = c.req.param('wid');
      const cardId = c.req.param('cardId');

      const scopedCard = await ctx.db.first<{ cardId: string; projectId: string }>(
        `SELECT c.id AS cardId, p.id AS projectId
         FROM cards c
         JOIN boards b ON b.id = c.board_id
         JOIN projects p ON p.id = b.project_id
         WHERE c.id = ? AND p.workspace_id = ?`,
        [cardId, wid],
      );
      if (!scopedCard) {
        return c.json({ error: { code: 'not_found', message: 'Card not found in workspace' } }, 404);
      }

      const estimate = await ctx.db.first<EstimationPointRow>(
        `SELECT card_id, workspace_id, project_id, points, sprint, updated_at
         FROM plugin_estimation_points
         WHERE card_id = ? AND workspace_id = ?`,
        [cardId, wid],
      );

      return c.json({
        cardId,
        projectId: scopedCard.projectId,
        points: estimate ? Number(estimate.points) : 0,
        sprint: estimate?.sprint ?? null,
        updatedAt: estimate?.updated_at ?? null,
      });
    });

    router.put(
      '/workspaces/:wid/cards/:cardId',
      requireIdentity,
      requireWorkspace,
      requireEditor,
      async (c) => {
        const wid = c.req.param('wid');
        const cardId = c.req.param('cardId');
        const body = (await c.req.json().catch(() => ({}))) as {
          points?: unknown;
          sprint?: unknown;
        };

        const points = typeof body.points === 'number' ? Math.trunc(body.points) : NaN;
        if (!Number.isFinite(points) || points < 0 || points > 100) {
          return c.json(
            { error: { code: 'invalid_points', message: 'points must be an integer between 0 and 100' } },
            400,
          );
        }

        const sprint =
          typeof body.sprint === 'string' && body.sprint.trim()
            ? body.sprint.trim().slice(0, 60)
            : null;

        const scopedCard = await ctx.db.first<{ cardId: string; projectId: string }>(
          `SELECT c.id AS cardId, p.id AS projectId
           FROM cards c
           JOIN boards b ON b.id = c.board_id
           JOIN projects p ON p.id = b.project_id
           WHERE c.id = ? AND p.workspace_id = ?`,
          [cardId, wid],
        );
        if (!scopedCard) {
          return c.json({ error: { code: 'not_found', message: 'Card not found in workspace' } }, 404);
        }

        const now = Date.now();
        await ctx.db.execute(
          `INSERT INTO plugin_estimation_points (card_id, workspace_id, project_id, points, sprint, updated_at)
           VALUES (?, ?, ?, ?, ?, ?)
           ON CONFLICT(card_id) DO UPDATE SET
             points = excluded.points,
             sprint = excluded.sprint,
             updated_at = excluded.updated_at`,
          [cardId, wid, scopedCard.projectId, points, sprint, now],
        );

        return c.json({
          cardId,
          workspaceId: wid,
          projectId: scopedCard.projectId,
          points,
          sprint,
          updatedAt: now,
        });
      },
    );

    ctx.route(router);

    ctx.on('task.created', async ({ cardId, workspaceId, projectId, cardType }) => {
      if (cardType !== 'estimate') return;
      await ctx.db.execute(
        `INSERT OR IGNORE INTO plugin_estimation_points
         (card_id, workspace_id, project_id, points, sprint, updated_at)
         VALUES (?, ?, ?, 1, 'sprint-current', ?)`,
        [cardId, workspaceId, projectId, Date.now()],
      );
    });

    ctx.registerMentionSource({
      kind: 'plugin:estimation:sprint',
      label: 'Sprints',
      async suggest(query, scope) {
        const q = query.trim().toLowerCase();
        const savedSprints = await ctx.db.query<{ sprint: string; pts: number }>(
          `SELECT sprint, SUM(points) AS pts
           FROM plugin_estimation_points
           WHERE workspace_id = ? AND sprint IS NOT NULL
           GROUP BY sprint`,
          [scope.workspaceId],
        );
        const candidates = [...DEFAULT_SPRINTS];
        for (const row of savedSprints) {
          if (!candidates.some((c) => c.id === row.sprint || c.label === row.sprint)) {
            candidates.push({
              id: row.sprint,
              label: row.sprint,
              description: `${Number(row.pts)} pts committed`,
            });
          }
        }
        return candidates
          .filter(
            (item) =>
              !q || item.id.toLowerCase().includes(q) || item.label.toLowerCase().includes(q),
          )
          .map((item) => ({
            id: item.id,
            label: item.label,
            description: item.description,
            kind: 'plugin:estimation:sprint',
          }));
      },
      async resolve(id, scope) {
        const matching = await ctx.db.first<{ pts: number }>(
          `SELECT COALESCE(SUM(points), 0) AS pts
           FROM plugin_estimation_points
           WHERE workspace_id = ? AND project_id = ? AND sprint = ?`,
          [scope.workspaceId, scope.projectId, id],
        );
        const fallback = DEFAULT_SPRINTS.find((s) => s.id === id);
        if (!fallback && Number(matching?.pts ?? 0) === 0) {
          return null;
        }
        return {
          kind: 'plugin:estimation:sprint',
          id,
          workspaceId: scope.workspaceId,
          projectId: scope.projectId,
          title: fallback?.label ?? id,
          subtitle: `${Number(matching?.pts ?? 0)} pts scheduled`,
          badge: 'SPRINT',
          href: null,
        };
      },
    });
  },
};

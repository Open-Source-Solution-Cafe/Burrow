import { Hono } from 'hono';
import { createMiddleware } from 'hono/factory';
import { z } from 'zod';
import { zValidator } from '@hono/zod-validator';
import type { Env } from '../app';
import type { IMemberRepository, IWorkspaceRepository } from '../infrastructure/types';
import type { AccessPolicy } from '../policy';
import { createExplicitWorkspaceMiddleware, requireRole } from '../middleware/session';
import { httpError } from '../services/errors';
import {
  FEATURE_FLAG_DEFINITIONS,
  parseFeatureFlagsEnv,
  resolveFeatureFlags,
  type FeatureFlagKey,
  type FeatureFlagMap,
} from '../../shared/featureFlags';

export interface FeatureFlagDeps {
  workspaces: IWorkspaceRepository;
  policy?: AccessPolicy;
  env?: Record<string, unknown>;
}

export async function resolveWorkspaceFeatureFlags(
  deps: FeatureFlagDeps & { workspaceId: string },
): Promise<FeatureFlagMap> {
  const rawEnv =
    typeof deps.env?.FEATURE_FLAGS === 'string'
      ? deps.env.FEATURE_FLAGS
      : typeof process !== 'undefined'
        ? process.env?.FEATURE_FLAGS
        : undefined;
  const envFlags = parseFeatureFlagsEnv(rawEnv);
  const policyFlags = deps.policy?.featureFlags?.() ?? {};
  const workspaceFlags = deps.workspaces.getFeatureFlags
    ? await deps.workspaces.getFeatureFlags(deps.workspaceId)
    : {};
  return resolveFeatureFlags({ envFlags, policyFlags, workspaceFlags });
}

export function requireFeatureFlag(flag: FeatureFlagKey, deps: FeatureFlagDeps) {
  return createMiddleware<Env>(async (c, next) => {
    const workspaceId = c.get('workspaceId') || c.req.param('wid');
    if (!workspaceId) {
      throw httpError(404, 'feature_disabled', `Feature "${flag}" is not enabled`);
    }
    const flags = await resolveWorkspaceFeatureFlags({ ...deps, workspaceId });
    if (!flags[flag]) {
      throw httpError(404, 'feature_disabled', `Feature "${flag}" is not enabled for this workspace`);
    }
    await next();
  });
}

const patchFeatureFlagsSchema = z
  .object({
    workspaceExport: z.boolean().optional(),
    notionImport: z.boolean().optional(),
    publicSharing: z.boolean().optional(),
    instanceMigration: z.boolean().optional(),
  })
  .strict();

export function createFeatureFlagRoutes(args: {
  workspaces: IWorkspaceRepository;
  members: IMemberRepository;
  policy?: AccessPolicy;
  env?: Record<string, unknown>;
}) {
  const { workspaces, members, policy, env } = args;
  const explicitWorkspace = createExplicitWorkspaceMiddleware(members);
  const route = new Hono<Env>();

  route.get('/:wid/feature-flags', explicitWorkspace, async (c) => {
    const workspaceId = c.get('workspaceId');
    const flags = await resolveWorkspaceFeatureFlags({ workspaces, policy, env, workspaceId });
    const policyOverrides = policy?.featureFlags?.() ?? {};
    c.header('Cache-Control', 'private, no-store');
    return c.json({
      flags,
      definitions: FEATURE_FLAG_DEFINITIONS,
      lockedKeys: Object.keys(policyOverrides),
    });
  });

  route.patch(
    '/:wid/feature-flags',
    explicitWorkspace,
    requireRole('owner'),
    zValidator('json', patchFeatureFlagsSchema),
    async (c) => {
      const workspaceId = c.get('workspaceId');
      const patch = c.req.valid('json');
      if (!workspaces.updateFeatureFlags) {
        throw httpError(501, 'not_implemented', 'Workspace feature flags not supported by repository');
      }
      const updated = await workspaces.updateFeatureFlags(workspaceId, c.get('userId'), patch);
      if (!updated) {
        throw httpError(403, 'forbidden', 'Workspace owner access required');
      }
      const flags = await resolveWorkspaceFeatureFlags({ workspaces, policy, env, workspaceId });
      const policyOverrides = policy?.featureFlags?.() ?? {};
      return c.json({
        flags,
        definitions: FEATURE_FLAG_DEFINITIONS,
        lockedKeys: Object.keys(policyOverrides),
      });
    },
  );

  return route;
}

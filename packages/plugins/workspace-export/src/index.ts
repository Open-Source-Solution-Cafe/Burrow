import type { BurrowServerPlugin, PluginManifest } from '@burrow/sdk';
import type { Infrastructure } from '../../../../src/core/infrastructure/types';
import type { PluginEventBus } from '../../../../src/core/plugins/event-bus';
import type { AccessPolicy } from '../../../../src/core/policy';
import { createWorkspaceExportRoutes } from '../../../../src/core/routes/workspace-export';

export const WORKSPACE_EXPORT_MANIFEST: PluginManifest = {
  id: 'workspace-export',
  name: 'Workspace Export & Import',
  version: '0.4.0',
  sdkVersion: '^0.4.0',
  permissions: ['routes:api'],
  description: 'First-party plugin providing portable workspace export/import routes.',
};

export interface WorkspaceExportPluginDeps {
  policy?: AccessPolicy;
  events?: PluginEventBus;
}

export function createWorkspaceExportPlugin(
  deps: WorkspaceExportPluginDeps = {},
): BurrowServerPlugin {
  return {
    manifest: WORKSPACE_EXPORT_MANIFEST,
    setup(ctx) {
      const infra = ctx.infra as Infrastructure & {
        policy?: AccessPolicy;
        events?: PluginEventBus;
      };

      ctx.route(
        createWorkspaceExportRoutes({
          repositories: infra.repositories,
          storage: infra.storage,
          policy: deps.policy ?? infra.policy,
          env: infra.env,
          events: deps.events ?? infra.events,
        }),
        { mountPath: '/api/workspaces' },
      );
    },
  };
}

export const workspaceExportPlugin: BurrowServerPlugin = createWorkspaceExportPlugin();

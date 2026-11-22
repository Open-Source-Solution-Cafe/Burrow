import type { BurrowServerPlugin, PluginManifest } from '@burrow/sdk';
import type { Infrastructure } from '../../../../src/core/infrastructure/types';
import type { AccessPolicy } from '../../../../src/core/policy';
import {
  createPublicShareViewerRoutes,
  createShareManagementRoutes,
} from '../../../../src/core/routes/public-shares';

export const PUBLIC_SHARING_MANIFEST: PluginManifest = {
  id: 'public-sharing',
  name: 'Public Read-Only Sharing',
  version: '0.4.0',
  sdkVersion: '^0.4.0',
  permissions: ['routes:api'],
  description: 'First-party plugin providing public share link management and read-only viewer routes.',
};

export interface PublicSharingPluginDeps {
  policy?: AccessPolicy;
}

export function createPublicSharingPlugin(
  deps: PublicSharingPluginDeps = {},
): BurrowServerPlugin {
  return {
    manifest: PUBLIC_SHARING_MANIFEST,
    setup(ctx) {
      const infra = ctx.infra as Infrastructure & { policy?: AccessPolicy };
      const policy = deps.policy ?? infra.policy;

      ctx.route(
        createShareManagementRoutes({
          repositories: infra.repositories,
          policy,
          env: infra.env,
        }),
        { mountPath: '/api' },
      );

      ctx.route(
        createPublicShareViewerRoutes({
          repositories: infra.repositories,
          storage: infra.storage,
          policy,
          env: infra.env,
        }),
        { mountPath: '/api/public/shares' },
      );
    },
  };
}

export const publicSharingPlugin: BurrowServerPlugin = createPublicSharingPlugin();

import { Hono } from 'hono';
import type {
  BurrowServerPlugin,
  Permission,
  PluginRouteMiddleware,
  ServerPluginContext,
} from '@burrow/sdk';
import type { AccessPolicy } from '../policy';
import type { AuthProvider, Infrastructure } from '../infrastructure/types';
import type { IStorageAdapter } from '../adapters/storage';
import type { IEmailProvider } from '../adapters/email';
import { PluginEventBus } from './event-bus';
import { MentionSourceRegistry } from './mention-registry';
import { validatePluginManifest } from './manifest';
import { createPluginDb } from './plugin-db';

export interface LoadedPluginsResult {
  pluginRoutes: Array<{ mountPath: string; router: Hono<any> }>;
  adapterOverrides: Partial<{
    auth: AuthProvider;
    storage: IStorageAdapter;
    mailer: IEmailProvider;
    policy: AccessPolicy;
  }>;
}

function assertPermission(manifestId: string, granted: ReadonlySet<Permission>, needed: Permission): void {
  if (!granted.has(needed)) {
    throw new Error(`Plugin "${manifestId}" lacks required permission "${needed}"`);
  }
}

export function loadServerPlugins(args: {
  plugins: ReadonlyArray<BurrowServerPlugin>;
  infra: Infrastructure;
  events: PluginEventBus;
  mentionRegistry: MentionSourceRegistry;
  middleware: PluginRouteMiddleware;
  rawDb?: unknown;
}): LoadedPluginsResult {
  const { plugins, infra, events, mentionRegistry, middleware } = args;
  const seenIds = new Set<string>();
  const pluginRoutes: Array<{ mountPath: string; router: Hono<any> }> = [];
  const adapterOverrides: LoadedPluginsResult['adapterOverrides'] = {};

  for (const plugin of plugins) {
    validatePluginManifest(plugin.manifest);
    const id = plugin.manifest.id;
    if (seenIds.has(id)) {
      throw new Error(`Duplicate plugin id "${id}"`);
    }
    seenIds.add(id);

    const granted = new Set<Permission>(plugin.manifest.permissions);
    const rawDb = args.rawDb ?? infra.db ?? infra.env?.DB;
    const realDb = createPluginDb(rawDb, id);

    const guardedDb: typeof realDb = {
      pluginId: realDb.pluginId,
      prefix: realDb.prefix,
      query: (sql, params) => {
        assertPermission(id, granted, 'db:own');
        return realDb.query(sql, params);
      },
      first: (sql, params) => {
        assertPermission(id, granted, 'db:own');
        return realDb.first(sql, params);
      },
      execute: (sql, params) => {
        assertPermission(id, granted, 'db:own');
        return realDb.execute(sql, params);
      },
      batch: (stmts) => {
        assertPermission(id, granted, 'db:own');
        return realDb.batch(stmts);
      },
    };

    const ctx: ServerPluginContext = {
      manifest: plugin.manifest,
      db: guardedDb,
      env: (infra.env ?? {}) as Record<string, unknown>,
      infra,
      middleware,
      route(router, options) {
        assertPermission(id, granted, 'routes:api');
        if (!(router instanceof Hono)) {
          throw new Error(`Plugin "${id}" route() expects a Hono router instance`);
        }
        const mountPath = options?.mountPath ?? `/api/plugins/${id}`;
        pluginRoutes.push({ mountPath, router });
      },
      on(event, handler) {
        assertPermission(id, granted, 'events:read');
        events.on(event, handler);
      },
      onBefore(event, handler) {
        assertPermission(id, granted, 'events:before');
        events.onBefore(event, handler);
      },
      registerMentionSource(source) {
        assertPermission(id, granted, 'mentions:register');
        mentionRegistry.register(id, source);
      },
      setAdapters(overrides) {
        if (overrides.auth) {
          assertPermission(id, granted, 'auth:override');
          adapterOverrides.auth = overrides.auth as AuthProvider;
        }
        if (overrides.storage) {
          assertPermission(id, granted, 'storage:override');
          adapterOverrides.storage = overrides.storage as IStorageAdapter;
        }
        if (overrides.mailer) {
          assertPermission(id, granted, 'mailer:override');
          adapterOverrides.mailer = overrides.mailer as IEmailProvider;
        }
        if (overrides.policy) {
          assertPermission(id, granted, 'policy:override');
          adapterOverrides.policy = overrides.policy as AccessPolicy;
        }
      },
    };

    const maybePromise = plugin.setup(ctx);
    if (maybePromise && typeof (maybePromise as PromiseLike<unknown>).then === 'function') {
      throw new Error(
        `Plugin "${id}" setup() returned a Promise; synchronous setup() is required for Worker request composition`,
      );
    }
  }

  return { pluginRoutes, adapterOverrides };
}

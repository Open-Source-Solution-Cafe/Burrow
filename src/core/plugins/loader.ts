import { Hono, type MiddlewareHandler } from 'hono';
import type {
  BurrowServerPlugin,
  Permission,
  PluginRouteMiddleware,
  ServerPluginContext,
  ValidatedPluginRouteDef,
  WorkspaceAccessResult,
  WorkspaceResourceRef,
} from '@burrow/sdk';
import type { AccessPolicy } from '../policy';
import type { AuthProvider, Infrastructure } from '../infrastructure/types';
import type { IStorageAdapter } from '../adapters/storage';
import type { IEmailProvider } from '../adapters/email';
import { httpError } from '../services/errors';
import { resolveVerifiedClientIp } from '../middleware/security';
import { PluginEventBus } from './event-bus';
import { MentionSourceRegistry } from './mention-registry';
import { assertPluginDialectSupported, validatePluginManifest } from './manifest';
import {
  createPluginDb,
  detectPluginDialect,
  getCurrentPluginHttpMethod,
  runWithPluginHttpMethod,
} from './plugin-db';
import { createPluginFetch } from './safe-fetch';
import { createPluginStorage } from './plugin-storage';
import { buildScopedPluginConfig, collectSecretValues, createPluginLogger, redactSecrets } from './logger';
import { parseDisabledPluginsEnv, type PluginRuntimeRegistry } from './runtime-state';

export interface LoadedPluginsResult {
  pluginRoutes: Array<{ mountPath: string; router: Hono<any> }>;
  adapterOverrides: Partial<{
    auth: AuthProvider;
    storage: IStorageAdapter;
    mailer: IEmailProvider;
    policy: AccessPolicy;
  }>;
}

const DEFAULT_ROUTE_TIMEOUT_MS = 5_000;
const DEFAULT_PLUGIN_RATE_LIMIT = 120; // requests per minute
const MAX_RATE_LIMIT_BUCKETS = 10_000;
const EMPTY_PLUGIN_ENV = Object.freeze({});
const RESERVED_BUILTIN_PLUGIN_IDS = new Set<string>(['public-sharing', 'workspace-export']);

function clonePluginManifest(manifest: BurrowServerPlugin['manifest']): BurrowServerPlugin['manifest'] {
  return {
    ...manifest,
    permissions: [...manifest.permissions],
    ...(manifest.network !== undefined ? { network: [...manifest.network] } : {}),
    ...(manifest.configKeys !== undefined ? { configKeys: [...manifest.configKeys] } : {}),
    ...(manifest.coreTables !== undefined ? { coreTables: [...manifest.coreTables] } : {}),
    ...(manifest.dialects !== undefined ? { dialects: [...manifest.dialects] } : {}),
    ...(manifest.dependencies !== undefined ? { dependencies: [...manifest.dependencies] } : {}),
  };
}

function deepFreezeManifest<T>(val: T): T {
  if (val && typeof val === 'object') {
    Object.freeze(val);
    for (const v of Object.values(val as Record<string, unknown>)) {
      if (v && typeof v === 'object' && !Object.isFrozen(v)) {
        deepFreezeManifest(v);
      }
    }
  }
  return val;
}

function assertPermission(manifestId: string, granted: ReadonlySet<Permission>, needed: Permission): void {
  if (!granted.has(needed)) {
    throw new Error(`Plugin "${manifestId}" lacks required permission "${needed}"`);
  }
}

/** Topologically orders plugins based on `manifest.dependencies`, throwing on missing or cyclic deps. */
export function sortPluginsByDependencies(
  plugins: ReadonlyArray<BurrowServerPlugin>,
): BurrowServerPlugin[] {
  const byId = new Map<string, BurrowServerPlugin>();
  for (const p of plugins) {
    validatePluginManifest(p.manifest);
    if (byId.has(p.manifest.id)) {
      throw new Error(`Duplicate plugin id "${p.manifest.id}"`);
    }
    byId.set(p.manifest.id, p);
  }

  const state = new Map<string, 'visiting' | 'visited'>();
  const ordered: BurrowServerPlugin[] = [];

  const visit = (plugin: BurrowServerPlugin) => {
    const id = plugin.manifest.id;
    const current = state.get(id);
    if (current === 'visited') return;
    if (current === 'visiting') {
      throw new Error(`Circular plugin dependency detected involving "${id}"`);
    }
    state.set(id, 'visiting');
    for (const depId of plugin.manifest.dependencies ?? []) {
      const dep = byId.get(depId);
      if (!dep) {
        throw new Error(`Plugin "${id}" depends on missing plugin "${depId}"`);
      }
      visit(dep);
    }
    state.set(id, 'visited');
    ordered.push(plugin);
  };

  for (const plugin of plugins) {
    visit(plugin);
  }

  return ordered;
}

function wrapPluginRouter(args: {
  pluginId: string;
  router: Hono<any>;
  isPublicRoute: boolean;
  runtimeRegistry?: PluginRuntimeRegistry;
  secretValues: readonly string[];
  requireIdentity: MiddlewareHandler;
  envObj?: Record<string, unknown>;
  timeoutMs?: number;
  maxRequestsPerMinute?: number;
}): Hono<any> {
  const {
    pluginId,
    router,
    isPublicRoute,
    runtimeRegistry,
    secretValues,
    requireIdentity,
    envObj,
    timeoutMs = DEFAULT_ROUTE_TIMEOUT_MS,
    maxRequestsPerMinute = DEFAULT_PLUGIN_RATE_LIMIT,
  } = args;

  const wrapper = new Hono<any>();
  const buckets = new Map<string, { count: number; resetAt: number }>();

  wrapper.use('*', async (c, next) => {
    if (runtimeRegistry && !runtimeRegistry.isEnabled(pluginId)) {
      return c.json(
        { error: { code: 'plugin_disabled', message: `Plugin "${pluginId}" is currently disabled` } },
        503,
      );
    }

    // Per-plugin sliding fixed-window rate limiter using verified peer IP only
    const now = Date.now();
    if (buckets.size > MAX_RATE_LIMIT_BUCKETS) {
      for (const [k, b] of buckets) {
        if (b.resetAt <= now) buckets.delete(k);
        if (buckets.size <= MAX_RATE_LIMIT_BUCKETS / 2) break;
      }
      if (buckets.size > MAX_RATE_LIMIT_BUCKETS) {
        buckets.clear();
      }
    }
    const identity = (c.get('identity') as { userId?: string } | undefined)?.userId;
    const ip = resolveVerifiedClientIp(c, { env: envObj }) ?? 'unverified';
    const key = `${pluginId}:${identity ?? 'anon'}:${ip}`;
    const bucket = buckets.get(key);
    if (!bucket || bucket.resetAt <= now) {
      buckets.set(key, { count: 1, resetAt: now + 60_000 });
    } else if (bucket.count >= maxRequestsPerMinute) {
      return c.json(
        { error: { code: 'rate_limit_exceeded', message: 'Plugin request rate limit exceeded' } },
        429,
      );
    } else {
      bucket.count++;
    }

    await next();

    // Prevent plugins from setting CSP or permissive CORS headers
    c.res.headers.delete('Access-Control-Allow-Origin');
    c.res.headers.delete('Access-Control-Allow-Credentials');
    c.res.headers.delete('Content-Security-Policy');
    c.res.headers.delete('Content-Security-Policy-Report-Only');
  });

  if (!isPublicRoute) {
    wrapper.use('*', requireIdentity);
  }

  const handlePluginError = (err: unknown, c: any) => {
    if (
      err &&
      typeof err === 'object' &&
      'status' in err &&
      typeof (err as { status: unknown }).status === 'number'
    ) {
      const status = (err as { status: number }).status;
      const code = 'code' in err ? String((err as { code?: unknown }).code ?? 'plugin_error') : 'plugin_error';
      const rawMsg = err instanceof Error ? err.message : 'Request failed';
      return c.json(
        { error: { code, message: redactSecrets(rawMsg, secretValues) } },
        status as any,
      );
    }
    const msg = err instanceof Error ? err.message : String(err ?? 'Plugin error');
    const redacted = redactSecrets(msg, secretValues);
    console.error(`[plugin:${pluginId}] route error:`, redacted);
    return c.json({ error: { code: 'plugin_error', message: 'Plugin request failed' } }, 500);
  };

  router.onError(handlePluginError);
  wrapper.onError(handlePluginError);

  wrapper.use('*', async (_c, next) => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const origEnvDesc = Object.getOwnPropertyDescriptor(_c, 'env');
    Object.defineProperty(_c, 'env', {
      value: EMPTY_PLUGIN_ENV,
      configurable: true,
      enumerable: true,
      writable: false,
    });
    try {
      await runWithPluginHttpMethod(_c.req.method, async () => {
        await Promise.race([
          next(),
          new Promise<never>((_, reject) => {
            timer = setTimeout(
              () => reject(httpError(504, 'plugin_timeout', `Plugin "${pluginId}" handler timed out`)),
              timeoutMs,
            );
          }),
        ]);
      });
    } finally {
      if (timer) clearTimeout(timer);
      if (origEnvDesc) {
        Object.defineProperty(_c, 'env', origEnvDesc);
      } else {
        delete (_c as { env?: unknown }).env;
      }
    }
  });

  wrapper.route('/', router);
  return wrapper;
}

export function loadServerPlugins(args: {
  plugins: ReadonlyArray<BurrowServerPlugin>;
  infra: Infrastructure;
  events: PluginEventBus;
  mentionRegistry: MentionSourceRegistry;
  middleware: PluginRouteMiddleware;
  rawDb?: unknown;
  runtimeRegistry?: PluginRuntimeRegistry;
  firstPartyCore?: boolean;
  consented?: boolean;
  consentedPluginIds?: ReadonlySet<string>;
  adapterOwners?: Map<string, string>;
  pluginsDisabledEnv?: unknown;
  disabledPluginsEnv?: unknown;
  timeoutMs?: number;
}): LoadedPluginsResult {
  const { plugins, infra, events, mentionRegistry, middleware, runtimeRegistry, firstPartyCore = false } = args;
  const orderedPlugins = sortPluginsByDependencies(plugins);
  const pluginRoutes: Array<{ mountPath: string; router: Hono<any> }> = [];
  const seenMountPaths = new Set<string>();
  const adapterOverrides: LoadedPluginsResult['adapterOverrides'] = {};
  const adapterOwners = args.adapterOwners ?? new Map<string, string>();
  const envObj = (infra.env ?? {}) as Record<string, unknown>;
  const activeDialect = detectPluginDialect(args.rawDb ?? infra.db ?? envObj.DB);
  const disabledCanonical = parseDisabledPluginsEnv(
    args.pluginsDisabledEnv ??
      envObj.PLUGINS_DISABLED ??
      (typeof process !== 'undefined' ? process.env?.PLUGINS_DISABLED : undefined),
  );
  const disabledDeprecated = parseDisabledPluginsEnv(
    args.disabledPluginsEnv ??
      envObj.DISABLED_PLUGINS ??
      (typeof process !== 'undefined' ? process.env?.DISABLED_PLUGINS : undefined),
  );

  for (const plugin of orderedPlugins) {
    const id = plugin.manifest.id;
    assertPluginDialectSupported(plugin.manifest, activeDialect);
    if (!firstPartyCore && RESERVED_BUILTIN_PLUGIN_IDS.has(id)) {
      throw new Error(`Plugin id "${id}" is reserved for built-in core functionality`);
    }
    const frozenManifest = deepFreezeManifest(clonePluginManifest(plugin.manifest));
    const ctxManifest = clonePluginManifest(plugin.manifest);
    const isConsented =
      firstPartyCore || Boolean(args.consented || args.consentedPluginIds?.has(id));
    runtimeRegistry?.register(frozenManifest, { firstPartyCore, consented: isConsented });

    const killSwitched =
      (runtimeRegistry?.isKillSwitched(id) ?? false) ||
      disabledCanonical.wildcardAll ||
      disabledDeprecated.wildcardAll ||
      disabledCanonical.ids.has(id) ||
      disabledDeprecated.ids.has(id);
    if (killSwitched) {
      continue;
    }

    const granted = new Set<Permission>(frozenManifest.permissions);
    const rawDb = args.rawDb ?? infra.db ?? envObj.DB;
    const realDb = createPluginDb(rawDb, id, {
      coreTables: frozenManifest.coreTables ?? [],
      registerNamespace: granted.has('db:own'),
    });
    const secretValues = collectSecretValues(envObj, frozenManifest.configKeys);
    const logger = createPluginLogger(id, secretValues);
    const scopedConfig = buildScopedPluginConfig(frozenManifest, envObj, firstPartyCore);
    const safeFetch = createPluginFetch(frozenManifest);
    const scopedStorage = createPluginStorage(id, infra.storage);

    const guardedDb: typeof realDb = {
      pluginId: realDb.pluginId,
      prefix: realDb.prefix,
      dialect: realDb.dialect,
      table: (shortName) => realDb.table(shortName),
      sql: (strings, ...values) => realDb.sql(strings, ...values),
      from: (shortName) => {
        assertPermission(id, granted, 'db:own');
        if (!realDb.from) {
          throw new Error(`Plugin "${id}" db.from() is not supported by database adapter`);
        }
        return realDb.from(shortName);
      },
      query: (sqlInput, params, opts) => {
        assertPermission(id, granted, 'db:own');
        return realDb.query(sqlInput, params, opts);
      },
      first: (sqlInput, params, opts) => {
        assertPermission(id, granted, 'db:own');
        return realDb.first(sqlInput, params, opts);
      },
      execute: (sqlInput, params, opts) => {
        assertPermission(id, granted, 'db:own');
        return realDb.execute(sqlInput, params, opts);
      },
      batch: (stmts) => {
        assertPermission(id, granted, 'db:own');
        return realDb.batch(stmts);
      },
    };

    const requireWorkspaceAccess = async (
      c: unknown,
      resource?: WorkspaceResourceRef,
    ): Promise<WorkspaceAccessResult> => {
      const hCtx = c as {
        get: (key: string) => any;
        req: { param: (name: string) => string | undefined };
      };
      const identity = hCtx.get('identity') as { userId?: string } | undefined;
      if (!identity?.userId) {
        throw httpError(401, 'unauthorized', 'Authentication required');
      }
      const workspaceId =
        resource?.workspaceId ??
        (resource?.kind === 'workspace' ? resource.id : undefined) ??
        hCtx.req.param('wid');
      if (!workspaceId) {
        throw httpError(404, 'not_found', 'Workspace not found');
      }
      const member = await infra.repositories.members.findByUserId(workspaceId, identity.userId);
      if (!member) {
        throw httpError(404, 'not_found', 'Workspace not found');
      }

      if (resource && resource.kind !== 'workspace') {
        const scope = { workspaceId, projectId: hCtx.req.param('pid') ?? '' };
        if (resource.kind === 'project') {
          const proj = await infra.repositories.projects.findByIdAndWorkspace(resource.id, workspaceId);
          if (!proj) throw httpError(404, 'not_found', 'Project not found');
        } else if (resource.kind === 'board') {
          const board = await infra.repositories.boards.findByIdInScope(
            { workspaceId, projectId: hCtx.req.param('pid') ?? '' },
            resource.id,
          );
          if (!board) throw httpError(404, 'not_found', 'Board not found');
        } else if (resource.kind === 'card') {
          const card = await infra.repositories.cards.findByIdInScope(
            { workspaceId, projectId: hCtx.req.param('pid') ?? '' },
            resource.id,
          );
          if (!card) throw httpError(404, 'not_found', 'Card not found');
        } else if (resource.kind === 'notepad') {
          const np = await infra.repositories.notepads.findByIdInScope(scope, resource.id);
          if (!np) throw httpError(404, 'not_found', 'Notepad not found');
        }
      }

      return {
        userId: identity.userId,
        workspaceId,
        role: member.role,
      };
    };

    const definedRouter = new Hono<any>();
    let hasDefinedRoutes = false;

    const assertHasRoutePermission = () => {
      if (!granted.has('routes:api') && !granted.has('routes:public')) {
        assertPermission(id, granted, 'routes:api');
      }
    };

    const mountCheckedRouter = (
      router: Hono<any>,
      options?: { mountPath?: string; public?: boolean; skipPublicPermCheck?: boolean },
    ) => {
      assertHasRoutePermission();
      const isPublic = Boolean(options?.public);
      if (isPublic && !firstPartyCore && !options?.skipPublicPermCheck) {
        assertPermission(id, granted, 'routes:public');
      }
      const defaultPath = `/api/plugins/${id}`;
      const requestedPath = options?.mountPath ?? defaultPath;
      if (!firstPartyCore && requestedPath !== defaultPath) {
        throw new Error(
          `Plugin "${id}" cannot override mountPath to "${requestedPath}" (must mount at "${defaultPath}")`,
        );
      }
      if (!firstPartyCore && seenMountPaths.has(requestedPath)) {
        throw new Error(`Route mountPath collision on "${requestedPath}"`);
      }
      seenMountPaths.add(requestedPath);

      const finalRouter = firstPartyCore
        ? router
        : wrapPluginRouter({
            pluginId: id,
            router,
            isPublicRoute: isPublic,
            runtimeRegistry,
            secretValues,
            requireIdentity: middleware.requireIdentity as MiddlewareHandler,
            envObj,
            timeoutMs: args.timeoutMs,
          });
      pluginRoutes.push({ mountPath: requestedPath, router: finalRouter });
    };

    const isEnabled = () => (runtimeRegistry ? runtimeRegistry.isEnabled(id) : true);

    const ctx: ServerPluginContext = {
      manifest: ctxManifest,
      db: guardedDb,
      config: scopedConfig,
      log: logger,
      fetch: safeFetch,
      storage: {
        put: (key, data, contentType) => {
          assertPermission(id, granted, 'storage:own');
          const method = getCurrentPluginHttpMethod();
          if (method === 'GET' || method === 'HEAD') {
            throw httpError(
              405,
              'method_not_allowed',
              `Plugin "${id}" cannot write to storage during an HTTP ${method} request`,
            );
          }
          return scopedStorage.put(key, data, contentType);
        },
        get: (key) => {
          assertPermission(id, granted, 'storage:own');
          return scopedStorage.get(key);
        },
        delete: (key) => {
          assertPermission(id, granted, 'storage:own');
          const method = getCurrentPluginHttpMethod();
          if (method === 'GET' || method === 'HEAD') {
            throw httpError(
              405,
              'method_not_allowed',
              `Plugin "${id}" cannot delete from storage during an HTTP ${method} request`,
            );
          }
          return scopedStorage.delete(key);
        },
        list: () => {
          assertPermission(id, granted, 'storage:own');
          return scopedStorage.list();
        },
      },
      // Raw env & infra are stripped for external plugins so permissions: [] cannot bypass guards
      env: firstPartyCore ? envObj : {},
      infra: firstPartyCore ? infra : undefined,
      middleware,
      requireRole: (minRole) => middleware.requireRole(minRole),
      requireWorkspaceAccess,
      route(router, options) {
        if (!(router instanceof Hono)) {
          throw new Error(`Plugin "${id}" route() expects a Hono router instance`);
        }
        mountCheckedRouter(router, options);
      },
      defineRoute<TParams = Record<string, string>, TQuery = Record<string, string>, TBody = unknown>(
        def: ValidatedPluginRouteDef<TParams, TQuery, TBody>,
      ) {
        assertHasRoutePermission();
        if (def.public && !firstPartyCore) {
          assertPermission(id, granted, 'routes:public');
        }
        const middlewares: MiddlewareHandler[] = [];
        if (!def.public) {
          middlewares.push(middleware.requireIdentity as MiddlewareHandler);
        }
        if (def.workspaceParam || def.minRole) {
          middlewares.push(middleware.requireWorkspace as MiddlewareHandler);
        }
        if (def.minRole) {
          middlewares.push(middleware.requireRole(def.minRole) as MiddlewareHandler);
        }

        const execHandler: MiddlewareHandler = async (c) => {
          let params = c.req.param() as unknown as TParams;
          if (def.schemas.params) {
            const parsed = def.schemas.params.safeParse(c.req.param());
            if (!parsed.success) {
              return c.json({ error: { code: 'validation_error', message: 'Invalid route parameters' } }, 400);
            }
            params = parsed.data;
          }

          let query = c.req.query() as unknown as TQuery;
          if (def.schemas.query) {
            const parsed = def.schemas.query.safeParse(c.req.query());
            if (!parsed.success) {
              return c.json({ error: { code: 'validation_error', message: 'Invalid query parameters' } }, 400);
            }
            query = parsed.data;
          }

          let body = undefined as unknown as TBody;
          if (def.schemas.body) {
            const rawBody = await c.req.json().catch(() => undefined);
            const parsed = def.schemas.body.safeParse(rawBody);
            if (!parsed.success) {
              return c.json({ error: { code: 'validation_error', message: 'Invalid request body' } }, 400);
            }
            body = parsed.data;
          }

          return def.handler(c, { params, query, body });
        };

        const methodLower = def.method.toLowerCase() as 'get' | 'post' | 'put' | 'patch' | 'delete';
        (definedRouter as any)[methodLower](def.path, ...middlewares, execHandler);
        hasDefinedRoutes = true;
      },
      on(event, handler) {
        assertPermission(id, granted, 'events:read');
        events.on(event, handler, { pluginId: id, isEnabled, secretValues, firstPartyCore });
      },
      onBefore(event, handler) {
        assertPermission(id, granted, 'events:before');
        events.onBefore(event, handler, { pluginId: id, isEnabled, secretValues, firstPartyCore });
      },
      registerMentionSource(source) {
        assertPermission(id, granted, 'mentions:register');
        mentionRegistry.register(id, source, { isEnabled });
      },
      setAdapters(overrides) {
        const claim = (kind: string) => {
          const prev = adapterOwners.get(kind);
          if (prev && prev !== id) {
            throw new Error(`Adapter override collision for "${kind}" between "${prev}" and "${id}"`);
          }
          adapterOwners.set(kind, id);
        };
        if (overrides.auth) {
          assertPermission(id, granted, 'auth:override');
          claim('auth');
          adapterOverrides.auth = overrides.auth as AuthProvider;
        }
        if (overrides.storage) {
          assertPermission(id, granted, 'storage:override');
          claim('storage');
          adapterOverrides.storage = overrides.storage as IStorageAdapter;
        }
        if (overrides.mailer) {
          assertPermission(id, granted, 'mailer:override');
          claim('mailer');
          adapterOverrides.mailer = overrides.mailer as IEmailProvider;
        }
        if (overrides.policy) {
          assertPermission(id, granted, 'policy:override');
          claim('policy');
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
    if (hasDefinedRoutes) {
      mountCheckedRouter(definedRouter, { public: true, skipPublicPermCheck: true });
    }
  }

  return { pluginRoutes, adapterOverrides };
}

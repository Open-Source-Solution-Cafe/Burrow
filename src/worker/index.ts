import { createCoreApp } from '../core/app';
import { createD1Infrastructure } from '../core/adapters/db/d1';
import { createDb } from '../core/adapters/db/d1/client';
import { ensureWorkerRuntimeEnv, type ResolvedWorkerBindings } from './bootstrap';
import type { Env } from './env';
import type { Hono } from 'hono';
import type { ExecutionContext } from 'hono';
import type { BurrowServerPlugin } from '@burrow/sdk';
import type { AccessPolicy } from '../core/policy';
import type { AuthProvider } from '../core/infrastructure/types';
import type { IStorageAdapter } from '../core/adapters/storage';
import type { IEmailProvider } from '../core/adapters/email';
import { PluginEventBus } from '../core/plugins/event-bus';

/**
 * Type for Cloudflare Workers fetch handler with environment bindings.
 */
export type ExportedHandler<EnvBindings> = {
  fetch: (request: Request, env: EnvBindings, ctx: ExecutionContext) => Promise<Response>;
};

export interface WorkerAppAdapters {
  auth?: AuthProvider;
  storage?: IStorageAdapter;
  mailer?: IEmailProvider;
  policy?: AccessPolicy;
}

export interface CreateAppOptions {
  plugins?: readonly BurrowServerPlugin[];
  policy?: AccessPolicy;
  adapters?: WorkerAppAdapters;
}

export interface CreateAppWithEnvOptions extends CreateAppOptions {
  env: Env['Bindings'] | ResolvedWorkerBindings;
}

/**
 * Create the Hono app for a given Worker environment.
 * Used by tests and the production fetch handler.
 */
export function createWorkerApp(
  env: Env['Bindings'] | ResolvedWorkerBindings,
  options: CreateAppOptions = {},
): Hono<any, any, any> {
  const events = new PluginEventBus();
  const baseInfra = createD1Infrastructure(
    createDb(env.DB),
    {
      FILES: env.FILES,
      BETTER_AUTH_SECRET: env.BETTER_AUTH_SECRET ?? '',
      BETTER_AUTH_URL: env.BETTER_AUTH_URL ?? '',
      BOOTSTRAP_TOKEN: env.BOOTSTRAP_TOKEN ?? '',
      RESEND_API_KEY: env.RESEND_API_KEY,
      EMAIL_FROM: env.EMAIL_FROM,
      GOOGLE_CLIENT_ID: env.GOOGLE_CLIENT_ID,
      GOOGLE_CLIENT_SECRET: env.GOOGLE_CLIENT_SECRET,
      GITHUB_CLIENT_ID: env.GITHUB_CLIENT_ID,
      GITHUB_CLIENT_SECRET: env.GITHUB_CLIENT_SECRET,
      SELF_UPDATE_WEBHOOK_URL: env.SELF_UPDATE_WEBHOOK_URL,
      SELF_UPDATE_WEBHOOK_TOKEN: env.SELF_UPDATE_WEBHOOK_TOKEN,
      SELF_UPDATE_WEBHOOK_REF: env.SELF_UPDATE_WEBHOOK_REF,
      PRIVACY_POLICY_URL: env.PRIVACY_POLICY_URL,
      TERMS_OF_SERVICE_URL: env.TERMS_OF_SERVICE_URL,
      TRUST_PROXY: env.TRUST_PROXY,
      TRUSTED_PROXIES: env.TRUSTED_PROXIES,
    },
    {
      runtime: 'worker',
      onBeforeDeleteUser: async (userId: string) => {
        await events.emitBefore('user.deleted', { userId });
      },
    },
  );
  const infra = {
    ...baseInfra,
    ...(options.adapters?.auth ? { auth: options.adapters.auth } : {}),
    ...(options.adapters?.storage ? { storage: options.adapters.storage } : {}),
    ...(options.adapters?.mailer ? { email: options.adapters.mailer } : {}),
  };
  return createCoreApp(infra, {
    policy: options.policy ?? options.adapters?.policy,
    plugins: options.plugins,
    events,
    rawDb: env.DB,
  });
}

/**
 * Compose a Burrow Cloudflare Worker (or return a Hono instance when `env` is supplied).
 */
export function createApp(options: CreateAppWithEnvOptions): Hono<any, any, any>;
export function createApp(options?: CreateAppOptions): ExportedHandler<Env['Bindings']>;
export function createApp(
  options: CreateAppOptions | CreateAppWithEnvOptions = {},
): Hono<any, any, any> | ExportedHandler<Env['Bindings']> {
  if ('env' in options && options.env) {
    return createWorkerApp(options.env, options);
  }
  const plugins = options.plugins ?? [];
  return {
    async fetch(request: Request, env: Env['Bindings'], ctx: ExecutionContext): Promise<Response> {
      const runtimeEnv = await ensureWorkerRuntimeEnv(env, request, plugins);
      const app = createWorkerApp(runtimeEnv, options);
      return app.fetch(request, runtimeEnv, ctx);
    },
  } satisfies ExportedHandler<Env['Bindings']>;
}

/** Default open-source Worker entrypoint with zero cloud plugins. */
export default createApp();

// Re-export AppType for Hono RPC clients (web frontend)
export type { AppType } from '../core/app';

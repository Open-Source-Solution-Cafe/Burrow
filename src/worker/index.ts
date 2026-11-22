import { createCoreApp } from '../core/app';
import { createD1Infrastructure } from '../core/adapters/db/d1';
import { createDb } from '../core/adapters/db/d1/client';
import { ensureWorkerRuntimeEnv, type ResolvedWorkerBindings } from './bootstrap';
import type { Env } from './env';
import type { Hono } from 'hono';
import type { ExecutionContext } from 'hono';

/**
 * Type for Cloudflare Workers fetch handler with environment bindings.
 */
type ExportedHandler<Env> = {
  fetch: (request: Request, env: Env, ctx: ExecutionContext) => Promise<Response>;
};

/**
 * Create the Hono app for a given Worker environment.
 * Used by tests and the production fetch handler.
 */
export function createWorkerApp(env: Env['Bindings'] | ResolvedWorkerBindings): Hono<any, any, any> {
  const infra = createD1Infrastructure(
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
    { runtime: 'worker' },
  );
  return createCoreApp(infra);
}

/**
 * Worker entrypoint - creates the app with D1 infrastructure from Cloudflare bindings.
 * The infrastructure is created per-request since bindings come from the fetch handler.
 */
export default {
  async fetch(request: Request, env: Env['Bindings'], ctx: ExecutionContext): Promise<Response> {
    const runtimeEnv = await ensureWorkerRuntimeEnv(env, request);
    const app = createWorkerApp(runtimeEnv);
    return app.fetch(request, runtimeEnv, ctx);
  },
} satisfies ExportedHandler<Env['Bindings']>;

// Re-export AppType for Hono RPC clients (web frontend)
export type { AppType } from '../core/app';

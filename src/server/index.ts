/* eslint-disable no-console */
process.env.NODE_ENV = process.env.NODE_ENV || 'production';

import { serve } from '@hono/node-server';
import { serveStatic } from '@hono/node-server/serve-static';
import fs from 'node:fs';
import path from 'node:path';
import { createCoreApp } from '../core/app';
import { PluginEventBus } from '../core/plugins/event-bus';
import { runPluginMigrations } from '../core/plugins/migrations';
import type { BurrowServerPlugin } from '@burrow/sdk';
import { loadConfig } from './config';
import { openNodeDb } from './db';
import { loadEnv } from './env';
import type { ServerConfig } from './config';

loadEnv();

// Migration jobs only require database access; supply fallbacks for auth validation
if (process.argv.includes('--migrate')) {
  if (
    !process.env.BETTER_AUTH_SECRET ||
    process.env.BETTER_AUTH_SECRET === 'dev-secret-change-me-32-bytes-minimum!!' ||
    process.env.BETTER_AUTH_SECRET === 'local-dev-secret-change-me'
  ) {
    process.env.BETTER_AUTH_SECRET = 'migration-secret-must-be-32-chars-long!!';
  }
  if (!process.env.BETTER_AUTH_URL || process.env.BETTER_AUTH_URL.includes('localhost')) {
    process.env.BETTER_AUTH_URL = 'http://burrow.migration.internal';
  }
}

const config = loadConfig();

function isPostgresUrl(url?: string): boolean {
  return typeof url === 'string' && url.startsWith('postgres');
}

const serverPlugins: readonly BurrowServerPlugin[] = [];

// Migrate-only CLI entry point (runs migrations and exits without starting the HTTP server)
if (process.argv.includes('--migrate')) {
  try {
    if (isPostgresUrl(config.DATABASE_URL)) {
      const { createPostgresInfrastructure } = await import('../core/adapters/db/postgres');
      const pgInfra = await createPostgresInfrastructure(config, { runMigrations: true });
      await runPluginMigrations(pgInfra.db, serverPlugins);
    } else {
      const { sqlite } = openNodeDb(config.SQLITE_PATH, `${process.cwd()}/migrations`);
      await runPluginMigrations(sqlite, serverPlugins);
      sqlite.close();
    }
    console.warn('Migrations applied successfully');
    process.exit(0);
  } catch (error) {
    console.error('Migration failed:', error);
    process.exit(1);
  }
}

async function buildInfrastructure(config: ServerConfig, events: PluginEventBus) {
  if (isPostgresUrl(config.DATABASE_URL)) {
    const { createPostgresInfrastructure } = await import('../core/adapters/db/postgres');
    const runMigrations = process.env.DATABASE_MIGRATE !== 'false';
    return createPostgresInfrastructure(config, {
      runMigrations,
      onBeforeDeleteUser: async (userId: string) => {
        await events.emitBefore('user.deleted', { userId });
      },
    });
  }
  const { db } = openNodeDb(config.SQLITE_PATH, `${process.cwd()}/migrations`);
  const { createD1Infrastructure } = await import('../core/adapters/db/d1');
  const { wrapNodeDb, createDb } = await import('../core/adapters/db/d1/client');
  const d1Db = createDb(wrapNodeDb(db));
  const env = {
    DB: d1Db,
    FILES: null,
    LOCAL_STORAGE_PATH: config.LOCAL_STORAGE_PATH,
    S3_ENDPOINT: config.S3_ENDPOINT,
    S3_REGION: config.S3_REGION,
    S3_BUCKET: config.S3_BUCKET,
    S3_ACCESS_KEY: config.S3_ACCESS_KEY,
    S3_SECRET_KEY: config.S3_SECRET_KEY,
    S3_FORCE_PATH_STYLE: config.S3_FORCE_PATH_STYLE,
    BETTER_AUTH_SECRET: config.BETTER_AUTH_SECRET,
    BETTER_AUTH_URL: config.BETTER_AUTH_URL,
    BOOTSTRAP_TOKEN: config.BOOTSTRAP_TOKEN,
    RESEND_API_KEY: config.RESEND_API_KEY,
    EMAIL_FROM: config.EMAIL_FROM,
    GOOGLE_CLIENT_ID: config.GOOGLE_CLIENT_ID,
    GOOGLE_CLIENT_SECRET: config.GOOGLE_CLIENT_SECRET,
    GITHUB_CLIENT_ID: config.GITHUB_CLIENT_ID,
    GITHUB_CLIENT_SECRET: config.GITHUB_CLIENT_SECRET,
    SELF_UPDATE_WEBHOOK_URL: config.SELF_UPDATE_WEBHOOK_URL,
    SELF_UPDATE_WEBHOOK_TOKEN: config.SELF_UPDATE_WEBHOOK_TOKEN,
    SELF_UPDATE_WEBHOOK_REF: config.SELF_UPDATE_WEBHOOK_REF,
    PRIVACY_POLICY_URL: config.PRIVACY_POLICY_URL,
    TERMS_OF_SERVICE_URL: config.TERMS_OF_SERVICE_URL,
    TRUST_PROXY: config.TRUST_PROXY,
    TRUSTED_PROXIES: config.TRUSTED_PROXIES,
    NODE_ENV: process.env.NODE_ENV,
  } as any;
  return createD1Infrastructure(d1Db as any, env, {
    runtime: 'node-sqlite',
    onBeforeDeleteUser: async (userId: string) => {
      await events.emitBefore('user.deleted', { userId });
    },
  });
}

const serverEvents = new PluginEventBus();
const infrastructure = await buildInfrastructure(config, serverEvents);
await runPluginMigrations(infrastructure.db, serverPlugins);

const app = createCoreApp(infrastructure, {
  plugins: serverPlugins,
  events: serverEvents,
  rawDb: infrastructure.db,
});

// Serve static frontend assets if dist/web exists (production SPA mode)
const webDistPath = path.resolve(process.cwd(), 'dist/web');
if (fs.existsSync(webDistPath)) {
  app.use('/*', serveStatic({ root: './dist/web' }));
  app.get('*', (c, next) => {
    if (c.req.path.startsWith('/api')) {
      return next();
    }
    return serveStatic({ path: './dist/web/index.html' })(c, next);
  });
}

const inContainer = process.env.BURROW_CONTAINER === 'true';
const isLocalDockerEval = config.ALLOW_LOCAL_DOCKER_EVAL === 'true';
// Inside Docker, container eth0 must accept Compose's 127.0.0.1 host port forwarding;
// direct host execution binds explicitly to config.BIND_HOST (default 127.0.0.1).
const listenHostname = inContainer ? '0.0.0.0' : config.BIND_HOST;

const server = serve(
  {
    fetch: (request, env) => app.fetch(request, env),
    port: config.PORT,
    hostname: listenHostname,
  },
  (info) => {
    const isProd = process.env.NODE_ENV === 'production';
    // Never leak BOOTSTRAP_TOKEN into production-mode container logs (including Docker local eval).
    const showBootstrapToken = !isProd;
    console.log('\n======================================================');
    console.log('Burrow Node Server');
    console.log(`  Listening URL:      http://${config.BIND_HOST === '::1' ? '[::1]' : config.BIND_HOST}:${info.port}`);
    if (isLocalDockerEval) {
      console.log(
        '  Mode:               Local evaluation (loopback-only) — disable ALLOW_LOCAL_DOCKER_EVAL for public production',
      );
    }
    if (config.BOOTSTRAP_TOKEN) {
      console.log(
        `  BOOTSTRAP_TOKEN:    ${showBootstrapToken ? config.BOOTSTRAP_TOKEN : '[REDACTED in production — read from .env]'}`,
      );
    } else {
      console.log(
        '  Initial Owner:      First account registered at /login claims Owner (then locks to invite-only)',
      );
    }
    console.log(
      `  Email Delivery:     ${config.RESEND_API_KEY ? `Resend (${config.EMAIL_FROM || 'default'})` : 'Console log fallback'}`,
    );
    console.log('======================================================\n');
  },
);

let shuttingDown = false;
function shutdown(signal: string): void {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`received ${signal}, closing node server`);
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 5000).unref();
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

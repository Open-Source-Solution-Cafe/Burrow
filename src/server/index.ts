process.env.NODE_ENV = process.env.NODE_ENV || 'production';

import { serve } from '@hono/node-server';
import { serveStatic } from '@hono/node-server/serve-static';
import fs from 'node:fs';
import path from 'node:path';
import { createCoreApp } from '../core/app';
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
  if (!process.env.BOOTSTRAP_TOKEN) {
    process.env.BOOTSTRAP_TOKEN = 'migration-bootstrap-token';
  }
}

const config = loadConfig();

function isPostgresUrl(url?: string): boolean {
  return typeof url === 'string' && url.startsWith('postgres');
}

// Migrate-only CLI entry point (runs migrations and exits without starting the HTTP server)
if (process.argv.includes('--migrate')) {
  try {
    if (isPostgresUrl(config.DATABASE_URL)) {
      const { createPostgresInfrastructure } = await import('../core/adapters/db/postgres');
      await createPostgresInfrastructure(config, { runMigrations: true });
    } else {
      const { sqlite } = openNodeDb(config.SQLITE_PATH, `${process.cwd()}/migrations`);
      sqlite.close();
    }
    console.warn('Migrations applied successfully');
    process.exit(0);
  } catch (error) {
    console.error('Migration failed:', error);
    process.exit(1);
  }
}

async function buildInfrastructure(config: ServerConfig) {
  if (isPostgresUrl(config.DATABASE_URL)) {
    const { createPostgresInfrastructure } = await import('../core/adapters/db/postgres');
    const runMigrations = process.env.DATABASE_MIGRATE !== 'false';
    return createPostgresInfrastructure(config, { runMigrations });
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
  } as any;
  return createD1Infrastructure(d1Db as any, env);
}

const infrastructurePromise = buildInfrastructure(config);

const app = createCoreApp(await infrastructurePromise);

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

const server = serve(
  {
    fetch: (request) => app.fetch(request),
    port: config.PORT,
  },
  (info) => {
    const isProd = process.env.NODE_ENV === 'production';
    console.log('\n======================================================');
    console.log('Burrow Node Server');
    console.log(`  Listening URL:      http://localhost:${info.port}`);
    console.log(
      `  BOOTSTRAP_TOKEN:    ${isProd ? '[REDACTED in production]' : config.BOOTSTRAP_TOKEN}`,
    );
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

import crypto from 'node:crypto';
import { z } from 'zod';

export function generateBootstrapToken(): string {
  return crypto.randomBytes(16).toString('hex');
}

export function generateAuthSecret(): string {
  return crypto.randomBytes(32).toString('hex');
}

export const KNOWN_SECRET_PLACEHOLDERS = new Set([
  'dev-secret-change-me-32-bytes-minimum!!',
  'local-dev-secret-change-me',
  'burrow-selfhost-secret-key-32-bytes-minimum!!',
]);

export const KNOWN_BOOTSTRAP_PLACEHOLDERS = new Set([
  'dev-bootstrap-token',
  'test-bootstrap-token',
  'burrow-bootstrap-token-initial-setup',
]);

function isLocalhostAuthUrl(url: string | undefined): boolean {
  if (!url) return false;
  try {
    const parsed = new URL(url);
    return parsed.hostname === 'localhost' || parsed.hostname === '127.0.0.1';
  } catch {
    return false;
  }
}

const configSchema = z.object({
  PORT: z.coerce.number().int().positive().default(3005),
  SQLITE_PATH: z.string().min(1).default('./data/burrow.db'),
  LOCAL_STORAGE_PATH: z.string().min(1).default('./data/uploads'),
  BETTER_AUTH_SECRET: z.string().min(1).default(() => generateAuthSecret()),
  BETTER_AUTH_URL: z.string().min(1).default('http://localhost:3005'),
  BOOTSTRAP_TOKEN: z.string().default(() => generateBootstrapToken()),
  ALLOW_LOCAL_DOCKER_EVAL: z.string().optional(),
  DATABASE_URL: z.string().optional(),
  RESEND_API_KEY: z.string().optional(),
  EMAIL_FROM: z.string().optional(),
  S3_ENDPOINT: z.string().optional(),
  S3_REGION: z.string().optional(),
  S3_BUCKET: z.string().optional(),
  S3_ACCESS_KEY: z.string().optional(),
  S3_SECRET_KEY: z.string().optional(),
  S3_FORCE_PATH_STYLE: z.string().optional(),
  GOOGLE_CLIENT_ID: z.string().optional(),
  GOOGLE_CLIENT_SECRET: z.string().optional(),
  GITHUB_CLIENT_ID: z.string().optional(),
  GITHUB_CLIENT_SECRET: z.string().optional(),
  SELF_UPDATE_WEBHOOK_URL: z.string().optional(),
  TRUST_PROXY: z.string().optional(),
  TRUSTED_PROXIES: z.string().optional(),
});

export type ServerConfig = z.infer<typeof configSchema>;

/** Load + validate the Node server env. Throws a zod error on bad input. */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): ServerConfig {
  const isProd = env.NODE_ENV === 'production';
  const rawUrl = env.BETTER_AUTH_URL?.trim();
  const rawSecret = env.BETTER_AUTH_SECRET?.trim();
  const rawBootstrap = env.BOOTSTRAP_TOKEN?.trim();
  const isLocalDockerEval = env.ALLOW_LOCAL_DOCKER_EVAL === 'true' && isLocalhostAuthUrl(rawUrl);

  if (rawSecret && KNOWN_SECRET_PLACEHOLDERS.has(rawSecret) && isProd) {
    throw new Error(
      'BETTER_AUTH_SECRET must be set to a unique secret (known placeholder secrets are rejected in production)',
    );
  }
  if (rawBootstrap && KNOWN_BOOTSTRAP_PLACEHOLDERS.has(rawBootstrap) && isProd) {
    throw new Error(
      'BOOTSTRAP_TOKEN must be set to a unique token (known placeholder tokens are rejected in production)',
    );
  }

  if (isProd) {
    if (
      !isLocalDockerEval &&
      (!rawSecret || KNOWN_SECRET_PLACEHOLDERS.has(rawSecret) || rawSecret.length < 32)
    ) {
      throw new Error(
        'BETTER_AUTH_SECRET must be set to a secure string of at least 32 characters in production',
      );
    }
    if (isLocalDockerEval && rawSecret && rawSecret.length < 32) {
      throw new Error(
        'BETTER_AUTH_SECRET must be at least 32 characters (or left empty for ephemeral local Docker evaluation)',
      );
    }
    if (
      !isLocalDockerEval &&
      (!rawBootstrap || KNOWN_BOOTSTRAP_PLACEHOLDERS.has(rawBootstrap) || rawBootstrap.length < 16)
    ) {
      throw new Error(
        'BOOTSTRAP_TOKEN must be set to a secure string of at least 16 characters in production',
      );
    }
    if (isLocalDockerEval && rawBootstrap && rawBootstrap.length < 16) {
      throw new Error(
        'BOOTSTRAP_TOKEN must be at least 16 characters (or left empty for ephemeral local Docker evaluation)',
      );
    }
    if (!rawUrl) {
      throw new Error('BETTER_AUTH_URL must be set in production');
    }
    let parsedAuthUrl: URL;
    try {
      parsedAuthUrl = new URL(rawUrl);
    } catch {
      throw new Error('BETTER_AUTH_URL must be a valid URL in production');
    }
    if (!isLocalDockerEval && (parsedAuthUrl.hostname === 'localhost' || parsedAuthUrl.hostname === '127.0.0.1')) {
      throw new Error('BETTER_AUTH_URL cannot point to localhost or 127.0.0.1 in production');
    }
  }

  let authSecret = rawSecret;
  if (!authSecret || (!isProd && KNOWN_SECRET_PLACEHOLDERS.has(authSecret))) {
    authSecret = generateAuthSecret();
  }

  let bootstrapToken = rawBootstrap;
  if (!bootstrapToken || (!isProd && KNOWN_BOOTSTRAP_PLACEHOLDERS.has(bootstrapToken))) {
    bootstrapToken = generateBootstrapToken();
  }

  return configSchema.parse({
    PORT: env.PORT,
    SQLITE_PATH: env.SQLITE_PATH,
    LOCAL_STORAGE_PATH: env.LOCAL_STORAGE_PATH,
    BETTER_AUTH_SECRET: authSecret,
    BETTER_AUTH_URL: rawUrl || undefined,
    BOOTSTRAP_TOKEN: bootstrapToken,
    ALLOW_LOCAL_DOCKER_EVAL: env.ALLOW_LOCAL_DOCKER_EVAL,
    DATABASE_URL: env.DATABASE_URL,
    RESEND_API_KEY: env.RESEND_API_KEY,
    EMAIL_FROM: env.EMAIL_FROM,
    S3_ENDPOINT: env.S3_ENDPOINT,
    S3_REGION: env.S3_REGION,
    S3_BUCKET: env.S3_BUCKET,
    S3_ACCESS_KEY: env.S3_ACCESS_KEY,
    S3_SECRET_KEY: env.S3_SECRET_KEY,
    S3_FORCE_PATH_STYLE: env.S3_FORCE_PATH_STYLE,
    GOOGLE_CLIENT_ID: env.GOOGLE_CLIENT_ID,
    GOOGLE_CLIENT_SECRET: env.GOOGLE_CLIENT_SECRET,
    GITHUB_CLIENT_ID: env.GITHUB_CLIENT_ID,
    GITHUB_CLIENT_SECRET: env.GITHUB_CLIENT_SECRET,
    SELF_UPDATE_WEBHOOK_URL: env.SELF_UPDATE_WEBHOOK_URL,
    TRUST_PROXY: env.TRUST_PROXY,
    TRUSTED_PROXIES: env.TRUSTED_PROXIES,
  });
}

import crypto from 'node:crypto';
import { z } from 'zod';
import { parseTrustedProxies } from '../core/shared/ip';

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
    return (
      (parsed.protocol === 'http:' || parsed.protocol === 'https:') &&
      (parsed.hostname === 'localhost' || parsed.hostname === '127.0.0.1')
    );
  } catch {
    return false;
  }
}

export function isLoopbackBindHost(host: string | undefined): boolean {
  if (!host || !host.trim()) return true;
  const normalized = host.trim().toLowerCase();
  return normalized === '127.0.0.1' || normalized === '::1' || normalized === 'localhost';
}

const configSchema = z.object({
  PORT: z.coerce.number().int().positive().default(3005),
  BIND_HOST: z.string().default('127.0.0.1'),
  SQLITE_PATH: z.string().min(1).default('./data/burrow.db'),
  LOCAL_STORAGE_PATH: z.string().min(1).default('./data/uploads'),
  BETTER_AUTH_SECRET: z.string().min(1).default(() => generateAuthSecret()),
  BETTER_AUTH_URL: z.string().min(1).default('http://localhost:3005'),
  BOOTSTRAP_TOKEN: z.string().default(''),
  ALLOW_LOCAL_DOCKER_EVAL: z.enum(['true', 'false']).default('false'),
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
  PRIVACY_POLICY_URL: z.string().optional(),
  TERMS_OF_SERVICE_URL: z.string().optional(),
  TRUST_PROXY: z.string().optional(),
  TRUSTED_PROXIES: z.string().optional(),
});

export type ServerConfig = z.infer<typeof configSchema>;

/** Load + validate the Node server env. Throws an explicit error on invalid or insecure config. */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): ServerConfig {
  const isProd = env.NODE_ENV === 'production';
  const rawUrl = env.BETTER_AUTH_URL?.trim();
  const rawSecret = env.BETTER_AUTH_SECRET?.trim();
  const rawBootstrap = env.BOOTSTRAP_TOKEN?.trim();
  const rawEvalFlag = env.ALLOW_LOCAL_DOCKER_EVAL?.trim();
  const rawBindHost = env.BIND_HOST?.trim();
  const rawProcessHost = env.HOST?.trim();

  if (rawEvalFlag && rawEvalFlag !== 'true' && rawEvalFlag !== 'false') {
    throw new Error(
      `Invalid ALLOW_LOCAL_DOCKER_EVAL value "${rawEvalFlag}": expected "true" or "false".`,
    );
  }

  const explicitLocalEvalOptIn = rawEvalFlag === 'true';
  if (explicitLocalEvalOptIn) {
    if (!isLocalhostAuthUrl(rawUrl)) {
      throw new Error(
        `ALLOW_LOCAL_DOCKER_EVAL=true requires a localhost or 127.0.0.1 BETTER_AUTH_URL (got "${rawUrl ?? ''}"). Set ALLOW_LOCAL_DOCKER_EVAL=false for public deployments.`,
      );
    }
    if (!isLoopbackBindHost(rawBindHost)) {
      throw new Error(
        `ALLOW_LOCAL_DOCKER_EVAL=true cannot bind to non-loopback BIND_HOST "${rawBindHost}". Use 127.0.0.1 for local evaluation or disable ALLOW_LOCAL_DOCKER_EVAL.`,
      );
    }
    if (rawProcessHost && !isLoopbackBindHost(rawProcessHost)) {
      throw new Error(
        `ALLOW_LOCAL_DOCKER_EVAL=true cannot bind to non-loopback HOST "${rawProcessHost}". Use 127.0.0.1 or disable ALLOW_LOCAL_DOCKER_EVAL.`,
      );
    }
    if (env.TRUST_PROXY === 'true' || Boolean(env.TRUSTED_PROXIES?.trim())) {
      throw new Error(
        'ALLOW_LOCAL_DOCKER_EVAL=true cannot be combined with TRUST_PROXY or TRUSTED_PROXIES forwarding.',
      );
    }
  }

  const isLocalDockerEval = explicitLocalEvalOptIn && isLocalhostAuthUrl(rawUrl);

  if (env.TRUSTED_PROXIES?.trim()) {
    parseTrustedProxies(env.TRUSTED_PROXIES);
  }
  if (isProd && env.TRUST_PROXY === 'true' && !env.TRUSTED_PROXIES?.trim()) {
    throw new Error(
      'TRUST_PROXY=true in production requires TRUSTED_PROXIES to list verified reverse-proxy IP addresses or CIDR ranges.',
    );
  }

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
    if (!rawSecret || KNOWN_SECRET_PLACEHOLDERS.has(rawSecret) || rawSecret.length < 32) {
      throw new Error(
        'BETTER_AUTH_SECRET must be set to a stable, securely generated string of at least 32 characters in production and persistent Docker deployments',
      );
    }
    if (
      rawBootstrap &&
      (KNOWN_BOOTSTRAP_PLACEHOLDERS.has(rawBootstrap) || rawBootstrap.length < 16)
    ) {
      throw new Error(
        'BOOTSTRAP_TOKEN must be set to a unique, securely generated string of at least 16 characters when configured in production',
      );
    }
    if (env.DATABASE_URL?.includes(':burrowpassword@')) {
      throw new Error(
        'DATABASE_URL uses the insecure default password "burrowpassword". Generate a unique POSTGRES_PASSWORD cleanly in .env.',
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
      throw new Error(
        'BETTER_AUTH_URL cannot point to localhost or 127.0.0.1 in production without explicit ALLOW_LOCAL_DOCKER_EVAL=true opt-in',
      );
    }
  }

  let authSecret = rawSecret;
  if (!authSecret || (!isProd && KNOWN_SECRET_PLACEHOLDERS.has(authSecret))) {
    authSecret = generateAuthSecret();
  }

  let bootstrapToken = rawBootstrap ?? '';
  if (
    !isProd &&
    (!bootstrapToken ||
      KNOWN_BOOTSTRAP_PLACEHOLDERS.has(bootstrapToken) ||
      bootstrapToken.length < 16)
  ) {
    bootstrapToken = '';
  }

  return configSchema.parse({
    PORT: env.PORT,
    BIND_HOST: rawBindHost || '127.0.0.1',
    SQLITE_PATH: env.SQLITE_PATH,
    LOCAL_STORAGE_PATH: env.LOCAL_STORAGE_PATH,
    BETTER_AUTH_SECRET: authSecret,
    BETTER_AUTH_URL: rawUrl || undefined,
    BOOTSTRAP_TOKEN: bootstrapToken,
    ALLOW_LOCAL_DOCKER_EVAL: explicitLocalEvalOptIn ? 'true' : 'false',
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
    PRIVACY_POLICY_URL: env.PRIVACY_POLICY_URL,
    TERMS_OF_SERVICE_URL: env.TERMS_OF_SERVICE_URL,
    TRUST_PROXY: env.TRUST_PROXY,
    TRUSTED_PROXIES: env.TRUSTED_PROXIES,
  });
}

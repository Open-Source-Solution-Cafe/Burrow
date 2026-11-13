import { betterAuth } from 'better-auth';
import { drizzleAdapter } from 'better-auth/adapters/drizzle';
import { magicLink } from 'better-auth/plugins';
import { and, eq } from 'drizzle-orm';
import type { AuthProvider } from '../infrastructure/types';
import type { SignupMode } from '../policy';
import type { IEmailProvider } from './email';
import { createEmailFromEnv } from './email/factory';

export interface AuthEnv {
  BETTER_AUTH_SECRET: string;
  BETTER_AUTH_URL: string;
  GITHUB_CLIENT_ID?: string;
  GITHUB_CLIENT_SECRET?: string;
  GOOGLE_CLIENT_ID?: string;
  GOOGLE_CLIENT_SECRET?: string;
  RESEND_API_KEY?: string;
  EMAIL_FROM?: string;
  TRUST_PROXY?: string;
  TRUSTED_PROXIES?: string;
  signupMode?: SignupMode;
  emailProvider?: IEmailProvider;
}

export interface AuthProviderOptions {
  onBeforeDeleteUser?: (userId: string) => Promise<void>;
}

interface RateLimitState {
  count: number;
  lastRequest: number;
}

/**
 * Shared DB-backed Better Auth rate-limit storage using the existing `verification` table.
 * Persists across Worker isolates and Node processes without requiring schema changes.
 */
export function createVerificationRateLimitStorage(db: any, verificationTable: any) {
  const memoryFallback = new Map<string, RateLimitState>();
  const canUseDb = Boolean(
    db &&
      typeof db.select === 'function' &&
      typeof db.insert === 'function' &&
      typeof db.update === 'function' &&
      verificationTable,
  );

  const consumeInMemory = (key: string, rule: { window: number; max: number }) => {
    const now = Date.now();
    const windowMs = rule.window * 1000;
    const entry = memoryFallback.get(key);
    if (!entry || now - entry.lastRequest >= windowMs) {
      memoryFallback.set(key, { count: 1, lastRequest: now });
      return { allowed: true, retryAfter: null };
    }
    if (entry.count >= rule.max) {
      return {
        allowed: false,
        retryAfter: Math.max(1, Math.ceil((entry.lastRequest + windowMs - now) / 1000)),
      };
    }
    entry.count += 1;
    return { allowed: true, retryAfter: null };
  };

  return {
    async consume(key: string, rule: { window: number; max: number }) {
      if (!canUseDb) {
        return consumeInMemory(key, rule);
      }

      const rowId = `rl:${key}`;
      const windowMs = rule.window * 1000;

      for (let attempt = 0; attempt < 3; attempt += 1) {
        const now = Date.now();
        const expiresAt = new Date(now + windowMs);
        try {
          const rows = await db
            .select({ value: verificationTable.value })
            .from(verificationTable)
            .where(eq(verificationTable.id, rowId))
            .limit(1);
          const existing = rows[0];

          if (!existing) {
            try {
              await db.insert(verificationTable).values({
                id: rowId,
                identifier: 'rate_limit',
                value: JSON.stringify({ count: 1, lastRequest: now }),
                expiresAt,
                createdAt: new Date(now),
                updatedAt: new Date(now),
              });
              return { allowed: true, retryAfter: null };
            } catch {
              // Concurrent insert race; retry loop reads the winner row.
              continue;
            }
          }

          let parsed: RateLimitState | null = null;
          try {
            parsed = JSON.parse(existing.value) as RateLimitState;
          } catch {
            parsed = null;
          }

          if (!parsed || typeof parsed.lastRequest !== 'number' || now - parsed.lastRequest >= windowMs) {
            const nextValue = JSON.stringify({ count: 1, lastRequest: now });
            const updated = await db
              .update(verificationTable)
              .set({ value: nextValue, expiresAt, updatedAt: new Date(now) })
              .where(and(eq(verificationTable.id, rowId), eq(verificationTable.value, existing.value)))
              .returning({ id: verificationTable.id });
            if (updated.length > 0) {
              return { allowed: true, retryAfter: null };
            }
            continue;
          }

          if (parsed.count >= rule.max) {
            return {
              allowed: false,
              retryAfter: Math.max(1, Math.ceil((parsed.lastRequest + windowMs - now) / 1000)),
            };
          }

          const nextValue = JSON.stringify({
            count: parsed.count + 1,
            lastRequest: parsed.lastRequest,
          });
          const updated = await db
            .update(verificationTable)
            .set({ value: nextValue, expiresAt, updatedAt: new Date(now) })
            .where(and(eq(verificationTable.id, rowId), eq(verificationTable.value, existing.value)))
            .returning({ id: verificationTable.id });
          if (updated.length > 0) {
            return { allowed: true, retryAfter: null };
          }
        } catch {
          return consumeInMemory(key, rule);
        }
      }

      return consumeInMemory(key, rule);
    },
  };
}

const oauth = (clientId?: string, clientSecret?: string, disableImplicitSignUp = true) =>
  clientId && clientSecret ? { clientId, clientSecret, disableImplicitSignUp } : undefined;

/** Auth resolves account identity; workspace membership supplies permissions. */
export function createAuthProvider(
  db: Parameters<typeof drizzleAdapter>[0],
  adapter: Parameters<typeof drizzleAdapter>[1],
  env: AuthEnv,
  signupMode?: SignupMode,
  emailProvider?: IEmailProvider,
  options?: AuthProviderOptions,
): AuthProvider {
  const isProd =
    (typeof process !== 'undefined' && process.env?.NODE_ENV === 'production') ||
    (!env.BETTER_AUTH_URL?.includes('localhost') && !env.BETTER_AUTH_URL?.includes('127.0.0.1'));
  if (
    isProd &&
    (!env.BETTER_AUTH_SECRET ||
      env.BETTER_AUTH_SECRET.length < 32 ||
      env.BETTER_AUTH_SECRET === 'dev-secret-change-me-32-bytes-minimum!!' ||
      env.BETTER_AUTH_SECRET === 'local-dev-secret-change-me' ||
      env.BETTER_AUTH_SECRET === 'burrow-selfhost-secret-key-32-bytes-minimum!!')
  ) {
    throw new Error('BETTER_AUTH_SECRET must be at least 32 characters in production');
  }

  const trustedOrigins = new Set<string>();
  if (env.BETTER_AUTH_URL) {
    try {
      trustedOrigins.add(new URL(env.BETTER_AUTH_URL).origin);
    } catch {
      // Malformed URLs must not enter the origin allowlist.
    }
  }
  if (!env.BETTER_AUTH_URL?.startsWith('https://')) {
    for (const host of ['localhost', '127.0.0.1']) {
      for (const port of ['', ':3005', ':5173', ':8787']) {
        trustedOrigins.add(`http://${host}${port}`);
      }
    }
  }
  const config = { ...(typeof process === 'undefined' ? {} : process.env), ...env };
  const effectiveSignupMode = signupMode ?? env.signupMode;
  const disableImplicitSignUp = effectiveSignupMode !== 'open';
  const effectiveEmailProvider =
    emailProvider ??
    env.emailProvider ??
    (env.RESEND_API_KEY || config.RESEND_API_KEY
      ? createEmailFromEnv(config)
      : createEmailFromEnv({}));

  const verificationTable = (adapter as any)?.schema?.verification;
  const rateLimitStorage = createVerificationRateLimitStorage(db, verificationTable);

  const auth = betterAuth({
    database: drizzleAdapter(db, adapter),
    secret: env.BETTER_AUTH_SECRET,
    baseURL: env.BETTER_AUTH_URL || 'http://localhost:3005',
    trustedOrigins: [...trustedOrigins],
    advanced: {
      ipAddress: {
        ipAddressHeaders: ['x-burrow-client-ip'],
      },
    },
    rateLimit: {
      enabled: true,
      window: 60,
      max: 100,
      customStorage: rateLimitStorage,
      customRules: {
        '/sign-up/*': { window: 60, max: 100 },
        '/sign-in/*': { window: 60, max: 100 },
      },
    },
    emailAndPassword: { enabled: true },
    plugins: [
      magicLink({
        sendMagicLink: async ({ email, url }) => {
          await effectiveEmailProvider.send({
            to: email,
            subject: 'Sign in to Burrow',
            html: `<p>Click the link below to sign in to your Burrow account:</p><p><a href="${url}">Sign in to Burrow</a></p><p>If you didn't request this email, you can safely ignore it.</p>`,
          });
        },
        disableSignUp: disableImplicitSignUp,
      }),
    ],
    socialProviders: {
      github: oauth(config.GITHUB_CLIENT_ID, config.GITHUB_CLIENT_SECRET, disableImplicitSignUp),
      google: oauth(config.GOOGLE_CLIENT_ID, config.GOOGLE_CLIENT_SECRET, disableImplicitSignUp),
    },
    session: {
      // Preserve Better Auth's database-session defaults on every backend.
      expiresIn: 60 * 60 * 24 * 7,
      updateAge: 60 * 60 * 24,
      cookieCache: { enabled: true, maxAge: 60 },
    },
    user: {
      deleteUser: {
        enabled: true,
        beforeDelete: async (user) => {
          if (options?.onBeforeDeleteUser) {
            await options.onBeforeDeleteUser(user.id);
          }
        },
      },
    },
  });
  return {
    async getSession(headers: Headers) {
      const session = await auth.api.getSession({ headers });
      return session
        ? {
            userId: session.user.id,
            email: session.user.email,
            name: session.user.name,
            image: session.user.image,
          }
        : null;
    },
    handler: (request) => {
      const forwardedReq = request.headers.has('x-burrow-client-ip')
        ? request
        : new Request(request, {
            headers: (() => {
              const headers = new Headers(request.headers);
              headers.set('x-burrow-client-ip', '127.0.0.1');
              return headers;
            })(),
          });
      return auth.handler(forwardedReq).catch((err) => {
        if (err && (typeof err.statusCode === 'number' || err.status)) {
          const status = typeof err.statusCode === 'number' ? err.statusCode : 400;
          const body = err.body || { message: err.message || 'Authentication error' };
          return new Response(JSON.stringify(body), {
            status,
            headers: { 'Content-Type': 'application/json' },
          });
        }
        throw err;
      });
    },
  };
}

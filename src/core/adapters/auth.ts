import { AsyncLocalStorage } from 'node:async_hooks';
import { betterAuth } from 'better-auth';
import { drizzleAdapter } from 'better-auth/adapters/drizzle';
import { createAuthMiddleware } from 'better-auth/api';
import { magicLink } from 'better-auth/plugins';
import type { AuthProvider } from '../infrastructure/types';
import type { SignupMode } from '../policy';
import type { IEmailProvider } from './email';
import { createEmailFromEnv } from './email/factory';
import {
  RateLimitUnavailableError,
  SqliteRateLimitStore,
  type RateLimitStore,
} from './rate-limit';

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
  NODE_ENV?: string;
  signupMode?: SignupMode;
  emailProvider?: IEmailProvider;
}

export interface AuthProviderOptions {
  onBeforeDeleteUser?: (userId: string) => Promise<void>;
  rateLimitStore?: RateLimitStore;
}

export interface AuthRequestContext {
  verifiedIp: string | null;
  accountKey: string | null;
  sessionKey: string | null;
  rateLimitError?: unknown;
}

const authRequestStorage = new AsyncLocalStorage<AuthRequestContext>();

export function runWithAuthRequestContext<T>(ctx: AuthRequestContext, fn: () => Promise<T>): Promise<T> {
  return authRequestStorage.run(ctx, fn);
}

const ACCOUNT_SCOPED_AUTH_PATHS = new Set([
  '/sign-in/email',
  '/sign-up/email',
  '/sign-in/magic-link',
  '/forget-password',
  '/request-password-reset',
  '/email-otp/send-verification-otp',
  '/email-otp/request-password-reset',
]);

const SPRAY_GUARDED_PATH_PREFIXES = [
  '/sign-in',
  '/sign-up',
  '/forget-password',
  '/request-password-reset',
  '/send-verification-email',
  '/change-password',
  '/change-email',
];

async function sha256Prefix(input: string, chars = 24): Promise<string> {
  const bytes = new TextEncoder().encode(input);
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('')
    .slice(0, chars);
}

function normalizeAuthSubpath(requestUrl: string, baseURL: string): string {
  try {
    const basePath = new URL(baseURL || 'http://localhost:3005').pathname.replace(/\/+$/, '');
    const reqPath = new URL(requestUrl).pathname.replace(/\/+$/, '');
    if (basePath && reqPath.startsWith(basePath)) {
      return reqPath.slice(basePath.length) || '/';
    }
    if (reqPath.startsWith('/api/auth')) {
      return reqPath.slice('/api/auth'.length) || '/';
    }
    return reqPath || '/';
  } catch {
    return '/';
  }
}

async function extractAccountKey(request: Request, subpath: string): Promise<string | null> {
  if (request.method.toUpperCase() !== 'POST') return null;
  if (!ACCOUNT_SCOPED_AUTH_PATHS.has(subpath)) return null;
  const contentType = request.headers.get('content-type') || '';
  if (!contentType.includes('application/json')) return null;

  try {
    const rawText = await request.clone().text();
    if (!rawText || rawText.length > 64 * 1024) return null;
    const body = JSON.parse(rawText) as { email?: unknown };
    if (typeof body?.email !== 'string') return null;
    const normalizedEmail = body.email.trim().toLowerCase();
    if (!normalizedEmail) return null;
    return `acct:${await sha256Prefix(normalizedEmail)}`;
  } catch {
    return null;
  }
}

async function extractSessionKey(request: Request): Promise<string | null> {
  const cookieHeader = request.headers.get('cookie');
  if (!cookieHeader) return null;
  const parts = cookieHeader.split(';');
  for (const part of parts) {
    const idx = part.indexOf('=');
    if (idx === -1) continue;
    const name = part.slice(0, idx).trim();
    if (name === 'better-auth.session_token' || name === '__Secure-better-auth.session_token') {
      const value = part.slice(idx + 1).trim();
      const tokenId = value.split('.')[0]?.trim();
      if (tokenId) {
        return `sess:${await sha256Prefix(tokenId)}`;
      }
    }
  }
  return null;
}

function serviceUnavailableResponse(): Response {
  return new Response(
    JSON.stringify({
      message: 'Authentication rate limiting is temporarily unavailable. Please try again later.',
      error: {
        code: 'service_unavailable',
        message: 'Authentication rate limiting is temporarily unavailable. Please try again later.',
      },
    }),
    {
      status: 503,
      headers: { 'Content-Type': 'application/json' },
    },
  );
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

  const effectiveBaseUrl = env.BETTER_AUTH_URL || 'http://localhost:3005';
  const rateLimitStore =
    options?.rateLimitStore ??
    new SqliteRateLimitStore(db as unknown as Parameters<typeof SqliteRateLimitStore['prototype']['consume']> extends never ? never : any);

  const auth = betterAuth({
    database: drizzleAdapter(db, adapter),
    secret: env.BETTER_AUTH_SECRET,
    baseURL: effectiveBaseUrl,
    trustedOrigins: [...trustedOrigins],
    experimental: {
      instrumentation: {
        enabled: false,
      },
    },
    advanced: {
      ipAddress: {
        ipAddressHeaders: ['x-burrow-client-ip'],
      },
    },
    rateLimit: {
      enabled: true,
      window: 60,
      max: 100,
      customStorage: rateLimitStore.createBetterAuthStorage({
        resolveKey: (rawKey) => {
          const ctx = authRequestStorage.getStore();
          const sepIdx = rawKey.indexOf('|');
          const path = sepIdx >= 0 ? rawKey.slice(sepIdx + 1) : rawKey;
          if (ctx?.accountKey) return `ba:${ctx.accountKey}|${path}`;
          if (ctx?.verifiedIp) return `ba:ip:${ctx.verifiedIp}|${path}`;
          if (ctx?.sessionKey) return `ba:${ctx.sessionKey}|${path}`;
          return `ba:anon|${path}`;
        },
        onError: (err) => {
          const ctx = authRequestStorage.getStore();
          if (ctx) ctx.rateLimitError = err;
        },
      }),
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
    hooks: {
      before: createAuthMiddleware(async (ctx) => {
        if (ctx.path !== '/sign-in/email') return;
        const body = ctx.body as { email?: unknown; password?: unknown } | undefined;
        if (!body || typeof body.email !== 'string' || typeof body.password !== 'string') {
          return;
        }
        const invalidCredentialsResponse = () =>
          new Response(
            JSON.stringify({
              code: 'INVALID_EMAIL_OR_PASSWORD',
              message: 'Invalid email or password',
            }),
            {
              status: 401,
              headers: { 'Content-Type': 'application/json' },
            },
          );
        const data = await ctx.context.internalAdapter.findUserByEmail(body.email.toLowerCase(), {
          includeAccounts: true,
        });
        if (!data) {
          await ctx.context.password.hash(body.password);
          return invalidCredentialsResponse();
        }
        const credentialAccount = data.accounts.find(
          (a: { providerId: string; password?: string | null }) => a.providerId === 'credential',
        );
        if (!credentialAccount?.password) {
          await ctx.context.password.hash(body.password);
          return invalidCredentialsResponse();
        }
        const isValid = await ctx.context.password.verify({
          hash: credentialAccount.password,
          password: body.password,
        });
        if (!isValid) {
          return invalidCredentialsResponse();
        }
      }),
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
    handler: async (request) => {
      const existingCtx = authRequestStorage.getStore();
      const subpath = normalizeAuthSubpath(request.url, effectiveBaseUrl);
      const verifiedIp = existingCtx?.verifiedIp ?? null;
      const accountKey = existingCtx?.accountKey ?? (await extractAccountKey(request, subpath));
      const sessionKey = existingCtx?.sessionKey ?? (await extractSessionKey(request));
      const reqCtx: AuthRequestContext = {
        verifiedIp,
        accountKey,
        sessionKey,
        rateLimitError: undefined,
      };

      const sanitizedHeaders = new Headers(request.headers);
      sanitizedHeaders.delete('x-burrow-client-ip');
      if (verifiedIp) {
        sanitizedHeaders.set('x-burrow-client-ip', verifiedIp);
      }

      const runAuthRequest = async () => {
        if (
          verifiedIp &&
          SPRAY_GUARDED_PATH_PREFIXES.some((prefix) => subpath.startsWith(prefix))
        ) {
          try {
            const spray = await rateLimitStore.consume(`auth-ip:${verifiedIp}`, 60_000, 25);
            if (!spray.allowed) {
              return new Response(
                JSON.stringify({ message: 'Too many requests. Please try again later.' }),
                {
                  status: 429,
                  statusText: 'Too Many Requests',
                  headers: {
                    'Content-Type': 'application/json',
                    'Retry-After': String(spray.retryAfterSeconds),
                    'X-Retry-After': String(spray.retryAfterSeconds),
                  },
                },
              );
            }
          } catch (err) {
            if (err instanceof RateLimitUnavailableError) {
              return serviceUnavailableResponse();
            }
            throw err;
          }
        }

        const sanitizedReq = new Request(request, { headers: sanitizedHeaders });
        try {
          const res = await auth.handler(sanitizedReq);
          if (reqCtx.rateLimitError) {
            return serviceUnavailableResponse();
          }
          if (res.status === 429 && !res.headers.has('Retry-After')) {
            const retryAfter = res.headers.get('X-Retry-After');
            if (retryAfter) {
              const patched = new Headers(res.headers);
              patched.set('Retry-After', retryAfter);
              return new Response(res.body, {
                status: res.status,
                statusText: res.statusText,
                headers: patched,
              });
            }
          }
          return res;
        } catch (err: any) {
          if (
            err instanceof RateLimitUnavailableError ||
            reqCtx.rateLimitError instanceof RateLimitUnavailableError
          ) {
            return serviceUnavailableResponse();
          }
          if (err && (typeof err.statusCode === 'number' || err.status)) {
            const status = typeof err.statusCode === 'number' ? err.statusCode : 400;
            const body = err.body || { message: err.message || 'Authentication error' };
            return new Response(JSON.stringify(body), {
              status,
              headers: { 'Content-Type': 'application/json' },
            });
          }
          throw err;
        }
      };

      return runWithAuthRequestContext(reqCtx, runAuthRequest);
    },
  };
}

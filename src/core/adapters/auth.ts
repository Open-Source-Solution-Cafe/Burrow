import { betterAuth } from 'better-auth';
import { drizzleAdapter } from 'better-auth/adapters/drizzle';
import type { AuthProvider } from '../infrastructure/types';

export interface AuthEnv {
  BETTER_AUTH_SECRET: string;
  BETTER_AUTH_URL: string;
  GITHUB_CLIENT_ID?: string;
  GITHUB_CLIENT_SECRET?: string;
  GOOGLE_CLIENT_ID?: string;
  GOOGLE_CLIENT_SECRET?: string;
}

const oauth = (clientId?: string, clientSecret?: string) =>
  clientId && clientSecret ? { clientId, clientSecret, disableImplicitSignUp: true } : undefined;

/** Auth resolves account identity; workspace membership supplies permissions. */
export function createAuthProvider(
  db: Parameters<typeof drizzleAdapter>[0],
  adapter: Parameters<typeof drizzleAdapter>[1],
  env: AuthEnv,
): AuthProvider {
  const isProd =
    (typeof process !== 'undefined' && process.env?.NODE_ENV === 'production') ||
    (!env.BETTER_AUTH_URL?.includes('localhost') && !env.BETTER_AUTH_URL?.includes('127.0.0.1'));
  if (
    isProd &&
    (!env.BETTER_AUTH_SECRET ||
      env.BETTER_AUTH_SECRET.length < 32 ||
      env.BETTER_AUTH_SECRET === 'dev-secret-change-me-32-bytes-minimum!!' ||
      env.BETTER_AUTH_SECRET === 'local-dev-secret-change-me')
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
  const auth = betterAuth({
    database: drizzleAdapter(db, adapter),
    secret: env.BETTER_AUTH_SECRET,
    baseURL: env.BETTER_AUTH_URL || 'http://localhost:3005',
    trustedOrigins: [...trustedOrigins],
    rateLimit: {
      enabled: true,
      window: 60,
      max: 100,
      customRules: {
        '/sign-up/*': { window: 60, max: 100 },
        '/sign-in/*': { window: 60, max: 100 },
      },
    },
    emailAndPassword: { enabled: true },
    socialProviders: {
      github: oauth(config.GITHUB_CLIENT_ID, config.GITHUB_CLIENT_SECRET),
      google: oauth(config.GOOGLE_CLIENT_ID, config.GOOGLE_CLIENT_SECRET),
    },
    session: {
      // Preserve Better Auth's database-session defaults on every backend.
      expiresIn: 60 * 60 * 24 * 7,
      updateAge: 60 * 60 * 24,
      cookieCache: { enabled: true, maxAge: 60 },
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
    handler: (request) => auth.handler(request),
  };
}

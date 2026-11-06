import { betterAuth } from 'better-auth';
import { drizzleAdapter } from 'better-auth/adapters/drizzle';
import { magicLink } from 'better-auth/plugins';
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
  signupMode?: SignupMode;
  emailProvider?: IEmailProvider;
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
  const effectiveSignupMode = signupMode ?? env.signupMode;
  const disableImplicitSignUp = effectiveSignupMode !== 'open';
  const effectiveEmailProvider =
    emailProvider ??
    env.emailProvider ??
    (env.RESEND_API_KEY || config.RESEND_API_KEY
      ? createEmailFromEnv(config)
      : createEmailFromEnv({}));

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

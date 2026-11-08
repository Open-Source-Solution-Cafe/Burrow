import type { drizzleAdapter } from 'better-auth/adapters/drizzle';
import { createAuthProvider, type AuthEnv, type AuthProviderOptions } from '../../auth';
import type { IEmailProvider } from '../../email';
import type { SignupMode } from '../../../policy';
import { user, session, account, verification } from './schema';

export const createAuthProviderWithDB = (
  db: Parameters<typeof drizzleAdapter>[0],
  env: AuthEnv,
  emailProvider?: IEmailProvider,
  signupMode?: SignupMode,
  options?: AuthProviderOptions,
) =>
  createAuthProvider(
    db,
    { provider: 'sqlite', schema: { user, session, account, verification } },
    env,
    signupMode ?? env.signupMode,
    emailProvider ?? env.emailProvider,
    options,
  );

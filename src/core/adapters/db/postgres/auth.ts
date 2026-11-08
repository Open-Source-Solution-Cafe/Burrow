import { createAuthProvider, type AuthEnv, type AuthProviderOptions } from '../../auth';
import type { IEmailProvider } from '../../email';
import type { SignupMode } from '../../../policy';
import type { PostgresDb } from './index';
import { user, session, account, verification } from './schema';

export const createPostgresAuthProvider = (
  db: PostgresDb,
  secret: string,
  url: string,
  emailProvider?: IEmailProvider,
  signupMode?: SignupMode,
  extraEnv?: Partial<AuthEnv>,
  options?: AuthProviderOptions,
) =>
  createAuthProvider(
    db,
    { provider: 'pg', schema: { user, session, account, verification } },
    { BETTER_AUTH_SECRET: secret, BETTER_AUTH_URL: url, ...extraEnv },
    signupMode,
    emailProvider,
    options,
  );

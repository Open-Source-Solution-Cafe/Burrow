import type { drizzleAdapter } from 'better-auth/adapters/drizzle';
import { createAuthProvider, type AuthEnv } from '../../auth';
import { user, session, account, verification } from './schema';

export const createAuthProviderWithDB = (db: Parameters<typeof drizzleAdapter>[0], env: AuthEnv) =>
  createAuthProvider(
    db,
    { provider: 'sqlite', schema: { user, session, account, verification } },
    env,
  );

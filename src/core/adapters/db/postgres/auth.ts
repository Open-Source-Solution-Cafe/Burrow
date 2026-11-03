import { createAuthProvider } from '../../auth';
import type { PostgresDb } from './index';
import { user, session, account, verification } from './schema';

export const createPostgresAuthProvider = (db: PostgresDb, secret: string, url: string) =>
  createAuthProvider(
    db,
    { provider: 'pg', schema: { user, session, account, verification } },
    { BETTER_AUTH_SECRET: secret, BETTER_AUTH_URL: url },
  );

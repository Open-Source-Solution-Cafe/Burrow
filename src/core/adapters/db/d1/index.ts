import { createStorageFromEnv } from '../../storage/factory';
import { SqliteFtsSearchAdapter } from './adapters/search/sqlite-fts';
import { SqlLockAdapter } from './adapters/lock/sql-lock';
import { createEmailFromEnv } from '../../email/factory';
import { createAuthProviderWithDB } from './auth';
import { createWorkspaceRepository } from './repositories/workspace';
import { createProjectRepository } from './repositories/project';
import { createProjectFileRepository } from './repositories/project-file';
import { createBoardRepository } from './repositories/board';
import { createCardRepository } from './repositories/card';
import { createNotepadRepository } from './repositories/notepad';
import { createTagRepository } from './repositories/tag';
import { createNotificationRepository } from './repositories/notification';
import { createMemberRepository } from './repositories/member';
import { createInviteRepository } from './repositories/invite';
import { createStorageDeletionRepository } from './repositories/storage-deletions';
import { createPublicShareRepository } from './repositories/public-share';
import { APIError } from 'better-auth/api';
import { MemberService } from '../../../services/members';
import { SqliteRateLimitStore } from '../../rate-limit';
import type { BurrowRuntime } from '../../../../shared/uploadPolicy';
import type { Infrastructure } from '../../../infrastructure/types';
import type { DB } from './client';

interface EnvBindings {
  FILES?: any;
  LOCAL_STORAGE_PATH?: string;
  S3_ENDPOINT?: string;
  S3_REGION?: string;
  S3_BUCKET?: string;
  S3_ACCESS_KEY?: string;
  S3_SECRET_KEY?: string;
  S3_FORCE_PATH_STYLE?: string;
  BETTER_AUTH_SECRET: string;
  BETTER_AUTH_URL: string;
  BOOTSTRAP_TOKEN: string;
  RESEND_API_KEY?: string;
  EMAIL_FROM?: string;
  GOOGLE_CLIENT_ID?: string;
  GOOGLE_CLIENT_SECRET?: string;
  GITHUB_CLIENT_ID?: string;
  GITHUB_CLIENT_SECRET?: string;
  SELF_UPDATE_WEBHOOK_URL?: string;
  SELF_UPDATE_WEBHOOK_TOKEN?: string;
  SELF_UPDATE_WEBHOOK_REF?: string;
  PRIVACY_POLICY_URL?: string;
  TERMS_OF_SERVICE_URL?: string;
  TRUST_PROXY?: string;
  TRUSTED_PROXIES?: string;
  NODE_ENV?: string;
}

/**
 * Create the full D1 infrastructure bundle for the core app.
 * This factory wires the existing D1/Drizzle implementation behind
 * the Phase 1 repository interfaces.
 */
export function createD1Infrastructure(
  db: DB,
  env: EnvBindings,
  options: { runtime?: BurrowRuntime } = {},
): Infrastructure {
  // Create adapters (stateless, can be shared)
  const search = new SqliteFtsSearchAdapter(db);
  const locks = new SqlLockAdapter(db);
  const storage = createStorageFromEnv(env);
  const email = createEmailFromEnv(env);
  const rateLimitStore = new SqliteRateLimitStore(db);

  // Create repositories (stateless, can be shared)
  const repositories = {
    workspaces: createWorkspaceRepository(db),
    projects: createProjectRepository(db),
    projectFiles: createProjectFileRepository(db),
    boards: createBoardRepository(db),
    cards: createCardRepository(db),
    notepads: createNotepadRepository(db),
    tags: createTagRepository(db),
    notifications: createNotificationRepository(db),
    members: createMemberRepository(db),
    invites: createInviteRepository(db),
    storageDeletions: createStorageDeletionRepository(db),
    publicShares: createPublicShareRepository(db),
  };

  const memberService = new MemberService(repositories);
  const auth = createAuthProviderWithDB(
    db,
    { ...env, emailProvider: email },
    email,
    undefined,
    {
      rateLimitStore,
      onBeforeDeleteUser: async (userId: string) => {
        try {
          await memberService.assertCanDeleteUser(userId, repositories.workspaces);
        } catch (err) {
          throw new APIError('BAD_REQUEST', {
            message: err instanceof Error ? err.message : 'cannot_delete_sole_owner',
          });
        }
      },
    },
  );

  return {
    repositories,
    storage,
    search,
    locks,
    auth,
    email,
    bootstrapToken: env.BOOTSTRAP_TOKEN,
    rateLimitStore,
    runtime: options.runtime,
    appUrl: env.BETTER_AUTH_URL,
    env,
  };
}

// Re-export constants for services that need them
export { MAX_NOTEPAD_DEPTH, MAX_CONTENT_BYTES, LOCK_TTL_MS } from '../../../shared/limits';

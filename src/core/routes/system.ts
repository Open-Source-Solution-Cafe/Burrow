import { Hono } from 'hono';
import { APP_VERSION } from '../version';
import type { AccessPolicy } from '../policy';
import type { IWorkspaceRepository } from '../infrastructure/types';
import type { Env } from '../app';
import {
  maxUploadBytesForRuntime,
  resolveDeploymentRuntime,
  type BurrowRuntime,
} from '../../shared/uploadPolicy';

export interface SystemRoutesOptions {
  policy?: AccessPolicy;
  workspaces: IWorkspaceRepository;
  env?: Record<string, any>;
  runtime?: BurrowRuntime;
  maxUploadBytes?: number;
}

let cachedRelease: {
  latestVersion: string;
  releaseNotesUrl: string;
  publishedAt: string | null;
  timestamp: number;
} | null = null;
const CACHE_TTL_MS = 60 * 60 * 1000; // 1 hour in-memory cache
const DEFAULT_RELEASES_URL = 'https://github.com/Open-Source-Solution-Cafe/Burrow/releases';

export function resetReleaseCacheForTests() {
  cachedRelease = null;
}

export function isNewerVersion(current: string, latest: string): boolean {
  const parse = (v: string) =>
    v
      .replace(/^v/, '')
      .split('.')
      .map((n) => parseInt(n, 10) || 0);
  const [cMaj = 0, cMin = 0, cPatch = 0] = parse(current);
  const [lMaj = 0, lMin = 0, lPatch = 0] = parse(latest);
  if (lMaj !== cMaj) return lMaj > cMaj;
  if (lMin !== cMin) return lMin > cMin;
  return lPatch > cPatch;
}

export async function fetchLatestReleaseInfo(
  currentVersion: string,
  env: Record<string, any> = {},
  forceRefresh = false,
): Promise<{ latestVersion: string; releaseNotesUrl: string; publishedAt: string | null }> {
  const now = Date.now();
  if (!forceRefresh && cachedRelease && now - cachedRelease.timestamp < CACHE_TTL_MS) {
    return {
      latestVersion: cachedRelease.latestVersion,
      releaseNotesUrl: cachedRelease.releaseNotesUrl,
      publishedAt: cachedRelease.publishedAt,
    };
  }
  const latestReleaseApi =
    (typeof env.BURROW_RELEASE_FEED_URL === 'string' && env.BURROW_RELEASE_FEED_URL) ||
    'https://api.github.com/repos/Open-Source-Solution-Cafe/Burrow/releases/latest';
  const tagsApi =
    (typeof env.BURROW_TAGS_FEED_URL === 'string' && env.BURROW_TAGS_FEED_URL) ||
    'https://api.github.com/repos/Open-Source-Solution-Cafe/Burrow/tags?per_page=1';
  const headers = {
    'User-Agent': 'Burrow-Self-Hosted',
    Accept: 'application/vnd.github.v3+json',
  };

  try {
    const res = await fetch(latestReleaseApi, {
      headers,
      signal: AbortSignal.timeout(3000),
    });
    if (res.ok) {
      const data = (await res.json()) as {
        tag_name?: string;
        html_url?: string;
        published_at?: string;
      };
      const latestVersion = data.tag_name ? data.tag_name.replace(/^v/, '') : currentVersion;
      const releaseNotesUrl = data.html_url || DEFAULT_RELEASES_URL;
      const publishedAt = data.published_at || null;
      cachedRelease = { latestVersion, releaseNotesUrl, publishedAt, timestamp: now };
      return { latestVersion, releaseNotesUrl, publishedAt };
    }

    // Fallback to /tags if repository has tags without formal GitHub Release objects
    if (res.status === 404) {
      const tagsRes = await fetch(tagsApi, {
        headers,
        signal: AbortSignal.timeout(3000),
      });
      if (tagsRes.ok) {
        const tags = (await tagsRes.json()) as Array<{ name?: string }>;
        const firstTag = tags[0]?.name;
        if (firstTag) {
          const latestVersion = firstTag.replace(/^v/, '');
          const releaseNotesUrl = `https://github.com/Open-Source-Solution-Cafe/Burrow/releases/tag/${encodeURIComponent(firstTag)}`;
          cachedRelease = { latestVersion, releaseNotesUrl, publishedAt: null, timestamp: now };
          return { latestVersion, releaseNotesUrl, publishedAt: null };
        }
      }
    }
  } catch {
    // Fail gracefully on air-gapped or rate-limited instances
  }

  return {
    latestVersion: cachedRelease?.latestVersion ?? currentVersion,
    releaseNotesUrl: cachedRelease?.releaseNotesUrl ?? DEFAULT_RELEASES_URL,
    publishedAt: cachedRelease?.publishedAt ?? null,
  };
}

export async function fetchLatestReleaseVersion(currentVersion: string): Promise<string> {
  const info = await fetchLatestReleaseInfo(currentVersion);
  return info.latestVersion;
}

export function createSystemRoutes(options: SystemRoutesOptions) {
  const { policy, workspaces, env = {} } = options;
  const runtime = resolveDeploymentRuntime({
    runtime: options.runtime,
    env,
    databaseUrl: typeof env?.DATABASE_URL === 'string' ? env.DATABASE_URL : undefined,
  });
  const maxUploadBytes = options.maxUploadBytes ?? maxUploadBytesForRuntime(runtime);
  const route = new Hono<Env>();

  route.get('/version', async (c) => {
    const allowSelfUpdate = policy?.allowSelfUpdate ? policy.allowSelfUpdate() : true;
    const currentVersion = APP_VERSION;
    const forceRefresh = c.req.query('refresh') === '1';
    const { latestVersion, releaseNotesUrl, publishedAt } = allowSelfUpdate
      ? await fetchLatestReleaseInfo(currentVersion, env, forceRefresh)
      : { latestVersion: currentVersion, releaseNotesUrl: DEFAULT_RELEASES_URL, publishedAt: null };
    const updateAvailable = allowSelfUpdate && isNewerVersion(currentVersion, latestVersion);
    const webhookConfigured = Boolean(
      env.SELF_UPDATE_WEBHOOK_URL ||
        (typeof process !== 'undefined' ? process.env?.SELF_UPDATE_WEBHOOK_URL : undefined),
    );

    c.header('Cache-Control', 'private, no-cache');
    return c.json({
      currentVersion,
      latestVersion,
      updateAvailable,
      allowSelfUpdate,
      releaseNotesUrl,
      publishedAt,
      webhookConfigured,
      runtime,
      maxUploadBytes,
    });
  });

  route.post('/update', async (c) => {
    const identity = c.get('identity');
    if (!identity) {
      return c.json({ error: { code: 'unauthorized', message: 'Authentication required' } }, 401);
    }

    const allowSelfUpdate = policy?.allowSelfUpdate ? policy.allowSelfUpdate() : true;
    if (!allowSelfUpdate) {
      return c.json(
        {
          error: {
            code: 'self_update_disabled',
            message: 'Self update is disabled by instance policy',
          },
        },
        403,
      );
    }

    const isInstanceAdmin = workspaces.isInstanceOwner
      ? await workspaces.isInstanceOwner(identity.userId)
      : false;
    if (!isInstanceAdmin) {
      return c.json(
        {
          error: {
            code: 'forbidden',
            message: 'Only the authorized instance administrator can initiate system updates',
          },
        },
        403,
      );
    }

    const webhookUrl =
      env.SELF_UPDATE_WEBHOOK_URL ||
      (typeof process !== 'undefined' ? process.env?.SELF_UPDATE_WEBHOOK_URL : undefined);
    if (webhookUrl) {
      try {
        const webhookRes = await fetch(webhookUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            event: 'system.update',
            triggeredBy: identity.userId,
            timestamp: Date.now(),
          }),
        });
        return c.json({
          ok: true,
          status: 'triggered',
          message: 'Self-update triggered via webhook',
          upstreamStatus: webhookRes.status,
        });
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : 'Webhook dispatch failed';
        return c.json({ error: { code: 'webhook_failed', message } }, 502);
      }
    }

    return c.json({
      ok: true,
      status: 'manual',
      message: 'Instance is ready to update. Pull the latest image and restart the container.',
    });
  });

  return route;
}

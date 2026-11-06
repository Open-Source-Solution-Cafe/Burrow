import { Hono } from 'hono';
import { APP_VERSION } from '../version';
import type { AccessPolicy } from '../policy';
import type { IWorkspaceRepository } from '../infrastructure/types';
import type { Env } from '../app';

export interface SystemRoutesOptions {
  policy?: AccessPolicy;
  workspaces: IWorkspaceRepository;
  env?: Record<string, any>;
}

let cachedRelease: { latestVersion: string; timestamp: number } | null = null;
const CACHE_TTL_MS = 60 * 60 * 1000; // 1 hour in-memory cache

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

export async function fetchLatestReleaseVersion(currentVersion: string): Promise<string> {
  const now = Date.now();
  if (cachedRelease && now - cachedRelease.timestamp < CACHE_TTL_MS) {
    return cachedRelease.latestVersion;
  }
  try {
    const res = await fetch(
      'https://api.github.com/repos/Open-Source-Solution-Cafe/Burrow/releases/latest',
      {
        headers: {
          'User-Agent': 'Burrow-Self-Hosted',
          Accept: 'application/vnd.github.v3+json',
        },
        signal: AbortSignal.timeout(3000),
      },
    );
    if (!res.ok) {
      return cachedRelease?.latestVersion ?? currentVersion;
    }
    const data = (await res.json()) as { tag_name?: string };
    const latest = data.tag_name ? data.tag_name.replace(/^v/, '') : currentVersion;
    cachedRelease = { latestVersion: latest, timestamp: now };
    return latest;
  } catch {
    return cachedRelease?.latestVersion ?? currentVersion;
  }
}

export function createSystemRoutes(options: SystemRoutesOptions) {
  const { policy, workspaces, env = {} } = options;
  const route = new Hono<Env>();

  route.get('/version', async (c) => {
    const allowSelfUpdate = policy?.allowSelfUpdate ? policy.allowSelfUpdate() : true;
    const currentVersion = APP_VERSION;
    const latestVersion = await fetchLatestReleaseVersion(currentVersion);
    const updateAvailable = isNewerVersion(currentVersion, latestVersion);

    c.header('Cache-Control', 'private, no-cache');
    return c.json({
      currentVersion,
      latestVersion,
      updateAvailable,
      allowSelfUpdate,
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

    const userWorkspaces = await workspaces.listByUser(identity.userId);
    const isOwner = userWorkspaces.some((w) => w.role === 'owner');
    if (!isOwner) {
      return c.json(
        {
          error: {
            code: 'forbidden',
            message: 'Only workspace owners can initiate system updates',
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

import { Hono } from 'hono';
import { APP_VERSION } from '../version';
import type { AccessPolicy } from '../policy';
import type { IWorkspaceRepository } from '../infrastructure/types';
import type { Env } from '../app';
import { isBlockedHostname } from '../plugins/safe-fetch';
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
export const UPDATE_CHECK_INTERVAL_MINUTES = 60;
const DEFAULT_RELEASES_URL = 'https://github.com/Open-Source-Solution-Cafe/Burrow/releases';
const DEFAULT_CHANGELOG_URL =
  'https://github.com/Open-Source-Solution-Cafe/Burrow/blob/master/CHANGELOG.md';
const SEMVER_TAG_RE = /^v?(\d+\.\d+\.\d+)$/;

export type SelfUpdateWebhookProvider = 'github' | 'gitlab' | 'cloudflare' | 'webhook';

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

export function validateSelfUpdateWebhookUrl(
  rawUrl: string,
  allowLoopbackHttp = false,
): { ok: true; url: URL } | { ok: false; reason: string } {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl.trim());
  } catch {
    return { ok: false, reason: 'SELF_UPDATE_WEBHOOK_URL must be a valid URL.' };
  }

  if (parsed.username || parsed.password) {
    return {
      ok: false,
      reason: 'SELF_UPDATE_WEBHOOK_URL must not contain embedded credentials.',
    };
  }

  const hostname = parsed.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  const isLoopback = hostname === 'localhost' || hostname === '127.0.0.1';
  if (allowLoopbackHttp && parsed.protocol === 'http:' && isLoopback) {
    return { ok: true, url: parsed };
  }

  if (parsed.protocol !== 'https:') {
    return { ok: false, reason: 'SELF_UPDATE_WEBHOOK_URL must use https:.' };
  }

  if (parsed.port && parsed.port !== '443') {
    return { ok: false, reason: 'SELF_UPDATE_WEBHOOK_URL must use default HTTPS port 443.' };
  }

  if (isBlockedHostname(hostname)) {
    return {
      ok: false,
      reason: 'SELF_UPDATE_WEBHOOK_URL must not target loopback, private, or internal hosts.',
    };
  }

  return { ok: true, url: parsed };
}

export function detectWebhookProvider(webhookUrl?: string): SelfUpdateWebhookProvider | null {
  const trimmed = webhookUrl?.trim();
  if (!trimmed) return null;
  try {
    const parsed = new URL(trimmed);
    const host = parsed.hostname.toLowerCase();
    const pathname = parsed.pathname.toLowerCase();
    if (host === 'api.github.com' || pathname.includes('/dispatches')) {
      return 'github';
    }
    if (pathname.includes('/trigger/pipeline') || host.includes('gitlab')) {
      return 'gitlab';
    }
    if (host === 'api.cloudflare.com' && pathname.includes('/deploy_hooks/')) {
      return 'cloudflare';
    }
    return 'webhook';
  } catch {
    return 'webhook';
  }
}

export function buildWebhookDispatchRequest(params: {
  webhookUrl: string;
  webhookToken?: string;
  webhookRef?: string;
  triggeredBy: string;
  currentVersion: string;
  targetVersion: string;
  timestamp?: number;
}): {
  url: string;
  provider: SelfUpdateWebhookProvider;
  headers: Record<string, string>;
  body?: string;
} {
  const {
    webhookUrl,
    webhookToken,
    webhookRef,
    triggeredBy,
    currentVersion,
    targetVersion,
    timestamp = Date.now(),
  } = params;
  const provider = detectWebhookProvider(webhookUrl) ?? 'webhook';
  const token = webhookToken?.trim();
  const ref = webhookRef?.trim() || 'main';

  if (provider === 'github') {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      Accept: 'application/vnd.github+json',
      'User-Agent': 'Burrow-Self-Hosted',
    };
    if (token) headers.Authorization = `Bearer ${token}`;
    const isWorkflowDispatch = /\/actions\/workflows\/[^/]+\/dispatches$/i.test(
      new URL(webhookUrl).pathname,
    );
    const body = isWorkflowDispatch
      ? JSON.stringify({ ref })
      : JSON.stringify({
          event_type: 'burrow-update',
          client_payload: {
            triggeredBy,
            currentVersion,
            targetVersion,
            timestamp,
          },
        });
    return { url: webhookUrl, provider, headers, body };
  }

  if (provider === 'gitlab') {
    const parsed = new URL(webhookUrl);
    const hasTokenInQuery = parsed.searchParams.has('token');
    const hasRefInQuery = parsed.searchParams.has('ref');
    const payload: Record<string, string> = {};
    if (!hasRefInQuery) payload.ref = ref;
    if (!hasTokenInQuery && token) payload.token = token;
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    return {
      url: webhookUrl,
      provider,
      headers,
      body: Object.keys(payload).length > 0 ? JSON.stringify(payload) : undefined,
    };
  }

  if (provider === 'cloudflare') {
    return {
      url: webhookUrl,
      provider,
      headers: {},
      body: undefined,
    };
  }

  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (token) headers.Authorization = `Bearer ${token}`;
  return {
    url: webhookUrl,
    provider,
    headers,
    body: JSON.stringify({
      event: 'system.update',
      triggeredBy,
      currentVersion,
      targetVersion,
      timestamp,
    }),
  };
}

function selectHighestSemverTag(tags: Array<{ name?: string }>): {
  version: string;
  rawTag: string;
} | null {
  let best: { version: string; rawTag: string } | null = null;
  for (const tag of tags) {
    const rawName = tag?.name?.trim();
    if (!rawName) continue;
    const match = SEMVER_TAG_RE.exec(rawName);
    const version = match?.[1];
    if (!version) continue;
    if (!best || isNewerVersion(best.version, version)) {
      best = { version, rawTag: rawName };
    }
  }
  return best;
}

export async function fetchLatestReleaseInfo(
  currentVersion: string,
  env: Record<string, any> = {},
  forceRefresh = false,
): Promise<{
  latestVersion: string;
  releaseNotesUrl: string;
  publishedAt: string | null;
  checkedAt: string;
}> {
  const now = Date.now();
  if (!forceRefresh && cachedRelease && now - cachedRelease.timestamp < CACHE_TTL_MS) {
    const latestVersion = isNewerVersion(currentVersion, cachedRelease.latestVersion)
      ? cachedRelease.latestVersion
      : currentVersion;
    return {
      latestVersion,
      releaseNotesUrl: cachedRelease.releaseNotesUrl,
      publishedAt: cachedRelease.publishedAt,
      checkedAt: new Date(cachedRelease.timestamp).toISOString(),
    };
  }
  const latestReleaseApi =
    (typeof env.BURROW_RELEASE_FEED_URL === 'string' && env.BURROW_RELEASE_FEED_URL) ||
    'https://api.github.com/repos/Open-Source-Solution-Cafe/Burrow/releases/latest';
  const tagsApi =
    (typeof env.BURROW_TAGS_FEED_URL === 'string' && env.BURROW_TAGS_FEED_URL) ||
    'https://api.github.com/repos/Open-Source-Solution-Cafe/Burrow/tags?per_page=20';
  const packageFeedUrl =
    (typeof env.BURROW_PACKAGE_FEED_URL === 'string' && env.BURROW_PACKAGE_FEED_URL) ||
    'https://raw.githubusercontent.com/Open-Source-Solution-Cafe/Burrow/master/package.json';
  const headers = {
    'User-Agent': 'Burrow-Self-Hosted',
    Accept: 'application/vnd.github.v3+json',
  };

  let bestVersion: string | null = null;
  let bestReleaseNotesUrl = DEFAULT_RELEASES_URL;
  let bestPublishedAt: string | null = null;

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
      if (data.tag_name) {
        bestVersion = data.tag_name.replace(/^v/, '');
        bestReleaseNotesUrl = data.html_url || DEFAULT_RELEASES_URL;
        bestPublishedAt = data.published_at || null;
      }
    }

    // Fallback to SemVer-sorted /tags when no GitHub Release object exists yet
    if (!bestVersion && res.status === 404) {
      const tagsRes = await fetch(tagsApi, {
        headers,
        signal: AbortSignal.timeout(3000),
      });
      if (tagsRes.ok) {
        const tags = (await tagsRes.json()) as Array<{ name?: string }>;
        const highest = selectHighestSemverTag(Array.isArray(tags) ? tags : []);
        if (highest) {
          bestVersion = highest.version;
          bestReleaseNotesUrl = `https://github.com/Open-Source-Solution-Cafe/Burrow/releases/tag/${encodeURIComponent(highest.rawTag)}`;
        }
      }
    }

    // Final fallback to upstream package.json when tags lag behind master releases
    if (!bestVersion || !isNewerVersion(currentVersion, bestVersion)) {
      const pkgRes = await fetch(packageFeedUrl, {
        headers: { 'User-Agent': 'Burrow-Self-Hosted' },
        signal: AbortSignal.timeout(3000),
      });
      if (pkgRes.ok) {
        const pkg = (await pkgRes.json()) as { version?: string };
        const pkgVersion = typeof pkg.version === 'string' ? pkg.version.trim() : '';
        if (SEMVER_TAG_RE.test(pkgVersion)) {
          const clean = pkgVersion.replace(/^v/, '');
          if (!bestVersion || isNewerVersion(bestVersion, clean)) {
            bestVersion = clean;
            bestReleaseNotesUrl = DEFAULT_CHANGELOG_URL;
            bestPublishedAt = null;
          }
        }
      }
    }
  } catch {
    // Fail gracefully on air-gapped or rate-limited instances
  }

  if (bestVersion) {
    const normalizedLatest = isNewerVersion(currentVersion, bestVersion)
      ? bestVersion
      : currentVersion;
    cachedRelease = {
      latestVersion: normalizedLatest,
      releaseNotesUrl: bestReleaseNotesUrl,
      publishedAt: bestPublishedAt,
      timestamp: now,
    };
    return {
      latestVersion: normalizedLatest,
      releaseNotesUrl: bestReleaseNotesUrl,
      publishedAt: bestPublishedAt,
      checkedAt: new Date(now).toISOString(),
    };
  }

  const fallbackVersion =
    cachedRelease && isNewerVersion(currentVersion, cachedRelease.latestVersion)
      ? cachedRelease.latestVersion
      : currentVersion;
  return {
    latestVersion: fallbackVersion,
    releaseNotesUrl: cachedRelease?.releaseNotesUrl ?? DEFAULT_RELEASES_URL,
    publishedAt: cachedRelease?.publishedAt ?? null,
    checkedAt: new Date(cachedRelease?.timestamp ?? now).toISOString(),
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

  const readEnv = (key: string): string | undefined => {
    const fromOpt = typeof env[key] === 'string' ? env[key].trim() : '';
    if (fromOpt) return fromOpt;
    const fromProcess =
      typeof process !== 'undefined' && typeof process.env?.[key] === 'string'
        ? process.env[key]!.trim()
        : '';
    return fromProcess || undefined;
  };

  route.get('/version', async (c) => {
    const allowSelfUpdate = policy?.allowSelfUpdate ? policy.allowSelfUpdate() : true;
    const currentVersion = APP_VERSION;
    const forceRefresh = c.req.query('refresh') === '1';
    const { latestVersion, releaseNotesUrl, publishedAt, checkedAt } = allowSelfUpdate
      ? await fetchLatestReleaseInfo(currentVersion, env, forceRefresh)
      : {
          latestVersion: currentVersion,
          releaseNotesUrl: DEFAULT_RELEASES_URL,
          publishedAt: null,
          checkedAt: new Date().toISOString(),
        };
    const updateAvailable = allowSelfUpdate && isNewerVersion(currentVersion, latestVersion);
    const webhookUrl = readEnv('SELF_UPDATE_WEBHOOK_URL');
    const webhookConfigured = Boolean(webhookUrl);
    const webhookProvider = detectWebhookProvider(webhookUrl);

    c.header('Cache-Control', 'private, no-cache');
    return c.json({
      currentVersion,
      latestVersion,
      updateAvailable,
      allowSelfUpdate,
      releaseNotesUrl,
      publishedAt,
      checkedAt,
      checkIntervalMinutes: UPDATE_CHECK_INTERVAL_MINUTES,
      webhookConfigured,
      webhookProvider,
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

    const webhookUrl = readEnv('SELF_UPDATE_WEBHOOK_URL');
    if (webhookUrl) {
      const allowLoopbackHttp =
        typeof process !== 'undefined' &&
        (process.env?.NODE_ENV === 'development' || process.env?.NODE_ENV === 'test');
      const validation = validateSelfUpdateWebhookUrl(webhookUrl, allowLoopbackHttp);
      if (!validation.ok) {
        return c.json(
          {
            error: {
              code: 'invalid_webhook_url',
              message: validation.reason,
            },
          },
          400,
        );
      }

      const targetVersion =
        cachedRelease && isNewerVersion(APP_VERSION, cachedRelease.latestVersion)
          ? cachedRelease.latestVersion
          : APP_VERSION;
      const dispatch = buildWebhookDispatchRequest({
        webhookUrl: validation.url.toString(),
        webhookToken: readEnv('SELF_UPDATE_WEBHOOK_TOKEN'),
        webhookRef: readEnv('SELF_UPDATE_WEBHOOK_REF'),
        triggeredBy: identity.userId,
        currentVersion: APP_VERSION,
        targetVersion,
      });
      try {
        const webhookRes = await fetch(dispatch.url, {
          method: 'POST',
          headers: dispatch.headers,
          body: dispatch.body,
          redirect: 'error',
          signal: AbortSignal.timeout(10000),
        });
        const webhookOk =
          typeof webhookRes.ok === 'boolean'
            ? webhookRes.ok
            : webhookRes.status >= 200 && webhookRes.status < 300;
        if (!webhookOk) {
          return c.json(
            {
              error: {
                code: 'webhook_failed',
                message: `Update webhook returned HTTP ${webhookRes.status}. Verify SELF_UPDATE_WEBHOOK_URL and SELF_UPDATE_WEBHOOK_TOKEN.`,
              },
            },
            502,
          );
        }
        const providerLabel =
          dispatch.provider === 'gitlab'
            ? 'GitLab CI'
            : dispatch.provider === 'github'
              ? 'GitHub Actions'
              : dispatch.provider === 'cloudflare'
                ? 'Cloudflare Workers Builds'
                : 'webhook';
        return c.json({
          ok: true,
          status: 'triggered',
          provider: dispatch.provider,
          message: `Upgrade triggered via ${providerLabel}. Your repository will sync and Cloudflare/host builds will redeploy automatically (typically 1–2 minutes).`,
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
      message:
        'Automated upgrade webhook is not configured yet. Follow the setup instructions below or run the upgrade command manually.',
    });
  });

  return route;
}

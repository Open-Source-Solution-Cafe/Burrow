import { createMiddleware } from 'hono/factory';
import type { Context } from 'hono';

export const DEFAULT_MAX_BODY_BYTES = 2_000_000; // 2 MB

const VALID_IP_REGEX = /^[0-9a-fA-F:.]{2,45}$/;

function extractValidIp(raw: string | undefined | null): string | null {
  if (!raw) return null;
  const trimmed = raw.trim().replace(/^::ffff:/i, '');
  if (!trimmed || trimmed.length > 45 || !VALID_IP_REGEX.test(trimmed)) return null;
  return trimmed;
}

/**
 * Resolve client IP from trusted proxy headers only when behind Cloudflare Workers
 * or when TRUST_PROXY=true. Never blindly trusts client-controlled X-Forwarded-For.
 */
export function resolveClientIp(
  c: Context,
  options?: { trustProxy?: boolean; env?: Record<string, any> },
): string {
  const runtimeEnv =
    options?.env ??
    ((c.env as Record<string, any> | undefined) && Object.keys(c.env as object).length > 0
      ? (c.env as Record<string, any>)
      : undefined) ??
    (typeof process !== 'undefined' ? process.env : {});

  const trustProxy =
    options?.trustProxy ??
    (runtimeEnv?.TRUST_PROXY === 'true' ||
      (typeof process !== 'undefined' && process.env?.TRUST_PROXY === 'true'));
  const isWorkersRuntime =
    Boolean((c.env as any)?.DB) ||
    typeof (globalThis as Record<string, unknown>).WebSocketPair !== 'undefined';

  if (isWorkersRuntime || trustProxy) {
    const cfIp = extractValidIp(c.req.header('cf-connecting-ip'));
    if (cfIp) return cfIp;
  }

  if (trustProxy) {
    const realIp = extractValidIp(c.req.header('x-real-ip'));
    if (realIp) return realIp;
    const forwardedFor = c.req.header('x-forwarded-for');
    if (forwardedFor) {
      const firstHop = extractValidIp(forwardedFor.split(',')[0]);
      if (firstHop) return firstHop;
    }
  }

  const socketIp = extractValidIp((c.env as any)?.incoming?.socket?.remoteAddress);
  if (socketIp) return socketIp;

  return '127.0.0.1';
}

export interface RateLimiterOptions {
  maxRequests: number;
  windowMs: number;
  prefix: string;
  env?: Record<string, unknown>;
}

/**
 * Lightweight per-IP sliding-window rate limiter middleware for sensitive public endpoints.
 */
export function rateLimiter(options: RateLimiterOptions) {
  const buckets = new Map<string, { count: number; resetAt: number }>();
  const { maxRequests, windowMs, prefix } = options;

  return createMiddleware(async (c, next) => {
    const now = Date.now();
    if (buckets.size > 10_000) {
      for (const [k, entry] of buckets) {
        if (now >= entry.resetAt) buckets.delete(k);
      }
    }

    const ip = resolveClientIp(c, { env: options.env });
    const key = `${prefix}:${ip}`;
    const existing = buckets.get(key);

    if (!existing || now >= existing.resetAt) {
      buckets.set(key, { count: 1, resetAt: now + windowMs });
      return next();
    }

    if (existing.count >= maxRequests) {
      const retryAfterSec = Math.max(1, Math.ceil((existing.resetAt - now) / 1000));
      c.header('Retry-After', String(retryAfterSec));
      return c.json(
        {
          error: {
            code: 'rate_limit_exceeded',
            message: 'Too many requests. Please try again later.',
          },
        },
        429,
      );
    }

    existing.count += 1;
    return next();
  });
}

/**
 * Standard security headers for all responses.
 */
export const securityHeaders = createMiddleware(async (c, next) => {
  await next();
  if (!c.res.headers.has('Content-Security-Policy')) {
    c.header(
      'Content-Security-Policy',
      "default-src 'self'; img-src 'self' data: blob: https:; style-src 'self' 'unsafe-inline'; font-src 'self' data:; connect-src 'self'; script-src 'self'; frame-src https://www.youtube-nocookie.com; frame-ancestors 'none'; base-uri 'self'",
    );
  }
  c.header('X-Content-Type-Options', 'nosniff');
  c.header('Referrer-Policy', 'strict-origin-when-cross-origin');
  c.header('X-Frame-Options', 'DENY');
  c.header('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
});

/**
 * Request body size limiter middleware.
 * Inspects Content-Length and wraps streaming bodies to return 413 even when Content-Length is missing or spoofed.
 */
export function bodyLimit(maxBytes = DEFAULT_MAX_BODY_BYTES) {
  return createMiddleware(async (c, next) => {
    const payloadTooLarge = () =>
      c.json(
        {
          error: {
            code: 'payload_too_large',
            message: `Request body exceeds limit of ${maxBytes} bytes`,
          },
        },
        413,
      );

    const contentLength = c.req.header('content-length');
    if (contentLength) {
      const len = Number.parseInt(contentLength, 10);
      if (!Number.isNaN(len) && len > maxBytes) {
        return payloadTooLarge();
      }
    }

    let exceeded = false;
    const method = c.req.method.toUpperCase();
    if (
      (method === 'POST' || method === 'PUT' || method === 'PATCH' || method === 'DELETE') &&
      c.req.raw.body
    ) {
      let bytesRead = 0;
      const limiter = new TransformStream<Uint8Array, Uint8Array>({
        transform(chunk, controller) {
          bytesRead += chunk.byteLength;
          if (bytesRead > maxBytes) {
            exceeded = true;
            controller.error(new Error(`Request body exceeds limit of ${maxBytes} bytes`));
            return;
          }
          controller.enqueue(chunk);
        },
      });
      const limitedBody = c.req.raw.body.pipeThrough(limiter);
      c.req.raw = new Request(c.req.raw, {
        body: limitedBody,
        duplex: 'half',
      } as RequestInit);
    }

    try {
      await next();
    } catch (error) {
      if (exceeded) {
        c.error = undefined;
        c.res = payloadTooLarge();
        return c.res;
      }
      throw error;
    }

    if (exceeded) {
      c.error = undefined;
      c.res = payloadTooLarge();
      return c.res;
    }
  });
}

/**
 * CSRF protection middleware against cross-site request forgery.
 * Blocks cross-site requests using Sec-Fetch-Site and Origin verification.
 */
export const csrfProtection = createMiddleware(async (c, next) => {
  const method = c.req.method.toUpperCase();
  if (method !== 'POST' && method !== 'PUT' && method !== 'PATCH' && method !== 'DELETE') {
    return next();
  }

  const path = c.req.path;
  if (path.startsWith('/api/auth/') || path === '/api/auth') {
    return next();
  }

  const secFetchSite = c.req.header('sec-fetch-site');
  if (secFetchSite === 'cross-site') {
    return c.json({ error: { code: 'forbidden', message: 'Cross-site request blocked' } }, 403);
  }

  const origin = c.req.header('origin');
  if (origin) {
    try {
      const originUrl = new URL(origin);
      const originHost = originUrl.host;
      const trustProxy =
        (c.env as any)?.TRUST_PROXY === 'true' ||
        (typeof process !== 'undefined' && process.env?.TRUST_PROXY === 'true');
      const forwardedHost = trustProxy ? c.req.header('x-forwarded-host') : undefined;
      const requestHost = forwardedHost || new URL(c.req.url).host;

      if (originHost !== requestHost) {
        // Allow loopback / localhost cross-port requests in local development (e.g. Vite on 3005 proxying to API on 8787)
        const isLoopbackOrigin =
          originUrl.hostname === 'localhost' || originUrl.hostname === '127.0.0.1';
        const requestHostname = requestHost.split(':')[0];
        const isLoopbackRequest =
          requestHostname === 'localhost' || requestHostname === '127.0.0.1';

        if (!isLoopbackOrigin || !isLoopbackRequest) {
          return c.json({ error: { code: 'forbidden', message: 'Cross-site request blocked' } }, 403);
        }
      }
    } catch {
      return c.json({ error: { code: 'forbidden', message: 'Cross-site request blocked' } }, 403);
    }
  }

  await next();
});

import { createMiddleware } from 'hono/factory';

export const DEFAULT_MAX_BODY_BYTES = 2_000_000; // 2 MB

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
 * Inspects Content-Length before or during stream read to return 413 quickly.
 */
export function bodyLimit(maxBytes = DEFAULT_MAX_BODY_BYTES) {
  return createMiddleware(async (c, next) => {
    const contentLength = c.req.header('content-length');
    if (contentLength) {
      const len = Number.parseInt(contentLength, 10);
      if (!Number.isNaN(len) && len > maxBytes) {
        return c.json(
          {
            error: {
              code: 'payload_too_large',
              message: `Request body exceeds limit of ${maxBytes} bytes`,
            },
          },
          413,
        );
      }
    }
    await next();
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
      const forwardedHost = c.req.header('x-forwarded-host');
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

import { sql } from 'drizzle-orm';
import type { DB } from './db/d1/client';
import type { PostgresDb } from './db/postgres';

/** Raised when persistent rate-limit backing storage cannot be reached or updated. */
export class RateLimitUnavailableError extends Error {
  readonly status = 503;
  readonly statusCode = 503;
  readonly code = 'service_unavailable';

  constructor(message = 'Rate limiting service is temporarily unavailable', cause?: unknown) {
    super(message);
    this.name = 'RateLimitUnavailableError';
    if (cause !== undefined) {
      (this as Error & { cause?: unknown }).cause = cause;
    }
  }
}

export interface RateLimitConsumeResult {
  allowed: boolean;
  count: number;
  limit: number;
  resetAt: number;
  retryAfterSeconds: number;
}

export interface BetterAuthRateLimitStorage {
  consume: (
    key: string,
    rule: { window: number; max: number },
  ) => Promise<{ allowed: boolean; retryAfter: number | null }>;
}

export interface BetterAuthRateLimitStorageOptions {
  resolveKey?: (rawKey: string, rule: { window: number; max: number }) => string;
  onError?: (error: unknown) => void;
}

export interface RateLimitStore {
  readonly persistent: boolean;
  consume(
    key: string,
    windowMs: number,
    maxRequests: number,
    now?: number,
  ): Promise<RateLimitConsumeResult>;
  pruneExpired(now?: number): Promise<number>;
  createBetterAuthStorage(options?: BetterAuthRateLimitStorageOptions): BetterAuthRateLimitStorage;
}

const DEFAULT_PRUNE_PROBABILITY = 0.05;
const BETTER_AUTH_PREFIX = 'ba:';

function makeBetterAuthStorage(
  store: Pick<RateLimitStore, 'consume'>,
  options: BetterAuthRateLimitStorageOptions = {},
): BetterAuthRateLimitStorage {
  return {
    consume: async (rawKey: string, rule: { window: number; max: number }) => {
      try {
        const key = options.resolveKey
          ? options.resolveKey(rawKey, rule)
          : `${BETTER_AUTH_PREFIX}${rawKey}`;
        const windowMs = Math.max(1, Number.isFinite(rule.window) ? rule.window : 60) * 1000;
        const maxRequests = Math.max(0, Number.isFinite(rule.max) ? rule.max : 100);
        const result = await store.consume(key, windowMs, maxRequests);
        return {
          allowed: result.allowed,
          retryAfter: result.allowed ? null : result.retryAfterSeconds,
        };
      } catch (error) {
        options.onError?.(error);
        throw error;
      }
    },
  };
}

function shouldOpportunisticallyPrune(probability: number): boolean {
  if (probability <= 0) return false;
  if (probability >= 1) return true;
  if (typeof crypto !== 'undefined' && typeof crypto.getRandomValues === 'function') {
    const buf = new Uint32Array(1);
    crypto.getRandomValues(buf);
    return buf[0]! / 0xffffffff < probability;
  }
  return Math.random() < probability;
}

function buildResult(
  count: number,
  maxRequests: number,
  resetAt: number,
  now: number,
): RateLimitConsumeResult {
  const allowed = maxRequests > 0 && count <= maxRequests;
  const retryAfterSeconds = allowed
    ? 0
    : Math.max(1, Math.ceil(Math.max(1, resetAt - now) / 1000));
  return {
    allowed,
    count,
    limit: maxRequests,
    resetAt,
    retryAfterSeconds,
  };
}

/**
 * Atomic SQLite/D1 persistent rate-limit store backed by the `rate_limits` table.
 * Fails closed (`RateLimitUnavailableError`) on any database failure; never falls
 * back to per-isolate memory.
 */
export class SqliteRateLimitStore implements RateLimitStore {
  readonly persistent = true;
  private readonly pruneProbability: number;

  constructor(
    private readonly db: DB,
    options: { pruneProbability?: number } = {},
  ) {
    this.pruneProbability = options.pruneProbability ?? DEFAULT_PRUNE_PROBABILITY;
  }

  async consume(
    key: string,
    windowMs: number,
    maxRequests: number,
    now = Date.now(),
  ): Promise<RateLimitConsumeResult> {
    const effectiveWindowMs = Math.max(1, windowMs);
    const nextResetAt = now + effectiveWindowMs;
    const cap = Math.max(0, maxRequests);

    try {
      const rows = await this.db.all<{ count: number; reset_at: number }>(sql`
        INSERT INTO rate_limits (key, count, reset_at)
        VALUES (${key}, 1, ${nextResetAt})
        ON CONFLICT (key) DO UPDATE SET
          count = CASE
            WHEN rate_limits.reset_at <= ${now} THEN 1
            WHEN rate_limits.count >= ${cap} THEN ${cap} + 1
            ELSE rate_limits.count + 1
          END,
          reset_at = CASE
            WHEN rate_limits.reset_at <= ${now} THEN ${nextResetAt}
            ELSE rate_limits.reset_at
          END
        RETURNING count, reset_at
      `);
      const row = rows[0];
      if (!row) {
        throw new RateLimitUnavailableError('Rate limit query returned no row');
      }
      if (shouldOpportunisticallyPrune(this.pruneProbability)) {
        await this.db.run(sql`DELETE FROM rate_limits WHERE reset_at <= ${now}`);
      }
      return buildResult(Number(row.count), cap, Number(row.reset_at), now);
    } catch (error) {
      if (error instanceof RateLimitUnavailableError) throw error;
      throw new RateLimitUnavailableError('Failed to update persistent SQLite rate limit', error);
    }
  }

  async pruneExpired(now = Date.now()): Promise<number> {
    try {
      const rows = await this.db.all<{ key: string }>(
        sql`DELETE FROM rate_limits WHERE reset_at <= ${now} RETURNING key`,
      );
      return rows.length;
    } catch (error) {
      throw new RateLimitUnavailableError('Failed to prune expired SQLite rate limits', error);
    }
  }

  createBetterAuthStorage(options?: BetterAuthRateLimitStorageOptions): BetterAuthRateLimitStorage {
    return makeBetterAuthStorage(this, options);
  }
}

/**
 * Atomic PostgreSQL persistent rate-limit store backed by the `rate_limits` table.
 * Uses a single `INSERT ... ON CONFLICT DO UPDATE` row lock to handle concurrent
 * requests atomically without lost updates, and always fails closed on DB error.
 */
export class PostgresRateLimitStore implements RateLimitStore {
  readonly persistent = true;
  private readonly pruneProbability: number;

  constructor(
    private readonly db: PostgresDb,
    options: { pruneProbability?: number } = {},
  ) {
    this.pruneProbability = options.pruneProbability ?? DEFAULT_PRUNE_PROBABILITY;
  }

  async consume(
    key: string,
    windowMs: number,
    maxRequests: number,
    now = Date.now(),
  ): Promise<RateLimitConsumeResult> {
    const effectiveWindowMs = Math.max(1, windowMs);
    const nextResetAt = now + effectiveWindowMs;
    const cap = Math.max(0, maxRequests);

    try {
      const rows = (await this.db.execute(sql`
        INSERT INTO rate_limits (key, count, reset_at)
        VALUES (${key}, 1, ${nextResetAt})
        ON CONFLICT (key) DO UPDATE SET
          count = CASE
            WHEN rate_limits.reset_at <= ${now} THEN 1
            WHEN rate_limits.count >= ${cap} THEN ${cap} + 1
            ELSE rate_limits.count + 1
          END,
          reset_at = CASE
            WHEN rate_limits.reset_at <= ${now} THEN ${nextResetAt}
            ELSE rate_limits.reset_at
          END
        RETURNING count, reset_at
      `)) as unknown as Array<{ count: number | string; reset_at: number | string }>;
      const row = rows[0];
      if (!row) {
        throw new RateLimitUnavailableError('Rate limit query returned no row');
      }
      if (shouldOpportunisticallyPrune(this.pruneProbability)) {
        await this.db.execute(sql`DELETE FROM rate_limits WHERE reset_at <= ${now}`);
      }
      return buildResult(Number(row.count), cap, Number(row.reset_at), now);
    } catch (error) {
      if (error instanceof RateLimitUnavailableError) throw error;
      throw new RateLimitUnavailableError(
        'Failed to update persistent PostgreSQL rate limit',
        error,
      );
    }
  }

  async pruneExpired(now = Date.now()): Promise<number> {
    try {
      const rows = (await this.db.execute(sql`
        WITH deleted AS (
          DELETE FROM rate_limits WHERE reset_at <= ${now} RETURNING 1
        )
        SELECT count(*)::int AS count FROM deleted
      `)) as unknown as Array<{ count: number | string }>;
      return Number(rows[0]?.count ?? 0);
    } catch (error) {
      throw new RateLimitUnavailableError('Failed to prune expired PostgreSQL rate limits', error);
    }
  }

  createBetterAuthStorage(options?: BetterAuthRateLimitStorageOptions): BetterAuthRateLimitStorage {
    return makeBetterAuthStorage(this, options);
  }
}

/**
 * Explicitly non-persistent in-memory store for isolated unit tests that construct
 * middleware or auth harnesses without a database. Never used as a fallback by DB stores.
 */
export class InMemoryRateLimitStore implements RateLimitStore {
  readonly persistent = false;
  private readonly buckets = new Map<string, { count: number; resetAt: number }>();

  async consume(
    key: string,
    windowMs: number,
    maxRequests: number,
    now = Date.now(),
  ): Promise<RateLimitConsumeResult> {
    if (this.buckets.size > 10_000) {
      await this.pruneExpired(now);
    }
    const cap = Math.max(0, maxRequests);
    const existing = this.buckets.get(key);
    if (!existing || existing.resetAt <= now) {
      const resetAt = now + Math.max(1, windowMs);
      const count = 1;
      this.buckets.set(key, { count, resetAt });
      return buildResult(count, cap, resetAt, now);
    }
    const nextCount = existing.count >= cap ? cap + 1 : existing.count + 1;
    existing.count = nextCount;
    return buildResult(nextCount, cap, existing.resetAt, now);
  }

  async pruneExpired(now = Date.now()): Promise<number> {
    let deleted = 0;
    for (const [k, entry] of this.buckets) {
      if (entry.resetAt <= now) {
        this.buckets.delete(k);
        deleted += 1;
      }
    }
    return deleted;
  }

  createBetterAuthStorage(options?: BetterAuthRateLimitStorageOptions): BetterAuthRateLimitStorage {
    return makeBetterAuthStorage(this, options);
  }
}

import postgres from 'postgres';
import { afterEach, beforeEach, describe, expect, inject, it } from 'vitest';
import { RateLimitUnavailableError } from '../../src/core/adapters/rate-limit';
import { openPersistence, type PersistenceFixture } from './node-fixture';

describe.each(['sqlite', 'postgres'] as const)('%s persistent rate-limit store', (kind) => {
  let fixture: PersistenceFixture;
  let admin: ReturnType<typeof postgres> | undefined;
  let database: string | undefined;

  beforeEach(async () => {
    let url = inject('postgresTestUrl');
    if (kind === 'postgres') {
      admin = postgres(url, { max: 1, onnotice: () => {} });
      database = `rl_node_${crypto.randomUUID().replaceAll('-', '')}`;
      await admin.unsafe(`CREATE DATABASE "${database}"`);
      const testUrl = new URL(url);
      testUrl.pathname = `/${database}`;
      url = testUrl.toString();
    }
    fixture = await openPersistence(kind, url);
  });

  afterEach(async () => {
    await fixture?.close();
    if (admin && database) await admin.unsafe(`DROP DATABASE "${database}" WITH (FORCE)`);
    await admin?.end();
  });

  it('enforces atomic increments under concurrent bursts', async () => {
    const now = 1_700_000_000_000;
    const key = `concurrent:${crypto.randomUUID()}`;
    const results = await Promise.all(
      Array.from({ length: 10 }, () => fixture.rateLimitStore.consume(key, 60_000, 3, now)),
    );

    const allowed = results.filter((entry) => entry.allowed);
    const denied = results.filter((entry) => !entry.allowed);
    expect(allowed).toHaveLength(3);
    expect(denied).toHaveLength(7);

    const rows = await fixture.query('SELECT count FROM rate_limits WHERE key = ?', [key]);
    expect(rows).toHaveLength(1);
    // Overflow cap clamps persisted count at maxRequests + 1 to prevent unbounded counter growth
    expect(Number(rows[0]?.count)).toBe(4);

    // Concurrent calls under limit must never lose increments (exact counter sum = 4)
    const exactKey = `concurrent-exact:${crypto.randomUUID()}`;
    const underLimitResults = await Promise.all(
      Array.from({ length: 4 }, () => fixture.rateLimitStore.consume(exactKey, 60_000, 10, now)),
    );
    expect(underLimitResults.every((entry) => entry.allowed)).toBe(true);
    expect(underLimitResults.map((entry) => entry.count).sort((a, b) => a - b)).toEqual([
      1, 2, 3, 4,
    ]);
    const exactRows = await fixture.query('SELECT count FROM rate_limits WHERE key = ?', [exactKey]);
    expect(Number(exactRows[0]?.count)).toBe(4);
  });

  it('resets counts after window expiry and prunes expired records cleanly', async () => {
    const t0 = 1_700_000_100_000;
    const expiredKey = `expired:${crypto.randomUUID()}`;
    const activeKey = `active:${crypto.randomUUID()}`;

    await fixture.rateLimitStore.consume(expiredKey, 10_000, 2, t0);
    await fixture.rateLimitStore.consume(expiredKey, 10_000, 2, t0);
    expect((await fixture.rateLimitStore.consume(expiredKey, 10_000, 2, t0)).allowed).toBe(false);

    // Expired key resets cleanly when window elapses
    const afterExpiry = await fixture.rateLimitStore.consume(expiredKey, 10_000, 2, t0 + 10_001);
    expect(afterExpiry.allowed).toBe(true);
    expect(afterExpiry.count).toBe(1);

    // Keep an active entry while aging out another expired entry for pruneExpired
    const obsoleteKey = `obsolete:${crypto.randomUUID()}`;
    await fixture.rateLimitStore.consume(obsoleteKey, 5_000, 1, t0);
    await fixture.rateLimitStore.consume(activeKey, 60_000, 5, t0 + 25_000);

    const removed = await fixture.rateLimitStore.pruneExpired(t0 + 25_000);
    expect(removed).toBeGreaterThanOrEqual(2);

    const remainingExpired = await fixture.query('SELECT key FROM rate_limits WHERE key = ?', [
      obsoleteKey,
    ]);
    const remainingActive = await fixture.query('SELECT key FROM rate_limits WHERE key = ?', [
      activeKey,
    ]);
    expect(remainingExpired).toEqual([]);
    expect(remainingActive).toHaveLength(1);
  });

  it('fails closed with RateLimitUnavailableError when rate_limits storage is unavailable', async () => {
    await fixture.query('DROP TABLE rate_limits');

    let caught: unknown = null;
    try {
      await fixture.rateLimitStore.consume('broken-key', 60_000, 3, Date.now());
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(RateLimitUnavailableError);
    expect((caught as RateLimitUnavailableError).status).toBe(503);
  });
});

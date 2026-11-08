import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { createWorkerApp } from '../../src/worker/index';
import { createDb } from '../../src/core/adapters/db/d1/client';
import * as t from '../../src/core/adapters/db/d1/schema';
import { eq } from 'drizzle-orm';

process.on('unhandledRejection', (reason: any) => {
  if (reason?.message?.includes('sole owner') || reason?.status === 'BAD_REQUEST') {
    return;
  }
  throw reason;
});

const app = createWorkerApp(env);
const db = createDb(env.DB);

describe('Better Auth delete-user entry point and sole owner guard', () => {
  const bootstrapToken = env.BOOTSTRAP_TOKEN || 'test-bootstrap-token';

  it('rejects deleting sole owner user through POST /api/auth/delete-user', async () => {
    // 1. Sign up as owner with bootstrap token
    const signupRes = await app.request(
      'http://localhost/api/auth/sign-up/email',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          email: 'sole-owner@example.com',
          password: 'password123',
          name: 'Sole Owner',
          bootstrapToken,
        }),
      },
      env,
    );

    expect(signupRes.status).toBe(200);
    const ownerCookie = signupRes.headers.get('set-cookie');
    expect(ownerCookie).toBeTruthy();

    const [userRow] = await db
      .select()
      .from(t.user)
      .where(eq(t.user.email, 'sole-owner@example.com'));
    expect(userRow).toBeDefined();

    // 2. Attempt deleting user via real Better Auth entry point
    const deleteRes = await app.request(
      'http://localhost/api/auth/delete-user',
      {
        method: 'POST',
        headers: {
          Cookie: ownerCookie!,
          Origin: 'http://localhost',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({}),
      },
      env,
    );

    expect(deleteRes.status).toBe(400);
    const deleteBody = (await deleteRes.json()) as { message?: string; error?: string };
    const errText = deleteBody.message || deleteBody.error || JSON.stringify(deleteBody);
    expect(errText.toLowerCase()).toContain('sole owner');

    // 3. User still exists in database
    const [userStillThere] = await db
      .select({ id: t.user.id, email: t.user.email })
      .from(t.user)
      .where(eq(t.user.email, 'sole-owner@example.com'));
    expect(userStillThere).toBeDefined();

    // Direct database deletion is also prevented by the trigger
    await expect(
      db.delete(t.user).where(eq(t.user.id, userRow!.id)),
    ).rejects.toThrow();

    // 4. Add a co-owner to the workspace
    const [membership] = await db
      .select()
      .from(t.members)
      .where(eq(t.members.userId, userRow!.id));
    expect(membership).toBeDefined();

    const coOwnerId = `usr_coowner_${Date.now()}`;
    await db.insert(t.user).values({
      id: coOwnerId,
      name: 'Co Owner',
      email: 'co-owner@example.com',
      emailVerified: true as any,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    await db.insert(t.members).values({
      workspaceId: membership!.workspaceId,
      userId: coOwnerId,
      role: 'owner',
      joinedAt: Date.now(),
    });

    // 5. Deleting user now succeeds through real Better Auth path
    const secondDeleteRes = await app.request(
      'http://localhost/api/auth/delete-user',
      {
        method: 'POST',
        headers: {
          Cookie: ownerCookie!,
          Origin: 'http://localhost',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({}),
      },
      env,
    );

    expect(secondDeleteRes.status).toBe(200);

    // 6. User is deleted, co-owner and workspace remain
    const [userAfterDelete] = await db
      .select({ id: t.user.id, email: t.user.email })
      .from(t.user)
      .where(eq(t.user.email, 'sole-owner@example.com'));
    expect(userAfterDelete).toBeUndefined();

    const [wsRemaining] = await db
      .select()
      .from(t.workspaces)
      .where(eq(t.workspaces.id, membership!.workspaceId));
    expect(wsRemaining).toBeDefined();
  });
});

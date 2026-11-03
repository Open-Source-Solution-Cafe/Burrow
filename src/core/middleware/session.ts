import { createMiddleware } from 'hono/factory';
import type { Env } from '../app';
import type { AuthProvider, IMemberRepository } from '../infrastructure/types';

const ROLE_RANK = {
  viewer: 1,
  editor: 2,
  owner: 3,
} as const;

type Role = keyof typeof ROLE_RANK;

export function sessionUnavailable(err: unknown) {
  console.error('Session retrieval error', err);
  return { error: { code: 'session_unavailable', message: 'Unable to verify your session' } };
}

/** Resolve the account session without assuming it belongs to a workspace. */
export const createIdentityMiddleware = (auth: AuthProvider) =>
  createMiddleware<Env>(async (c, next) => {
    try {
      const identity = await auth.getSession(c.req.raw.headers);
      if (identity) c.set('identity', identity);
    } catch (err) {
      return c.json(sessionUnavailable(err), 503);
    }
    await next();
  });

/** Resolve the requested workspace directly from the signed-in account's current membership. */
export const createExplicitWorkspaceMiddleware = (members: IMemberRepository) =>
  createMiddleware<Env>(async (c, next) => {
    c.header('Cache-Control', 'private, no-store');
    const identity = c.get('identity');
    const workspaceId = c.req.param('wid');
    if (!identity) {
      return c.json({ error: { code: 'unauthorized', message: 'Authentication required' } }, 401);
    }
    if (!workspaceId) {
      return c.json({ error: { code: 'not_found', message: 'Workspace not found' } }, 404);
    }
    let member;
    try {
      member = await members.findByUserId(workspaceId, identity.userId);
    } catch (err) {
      return c.json(sessionUnavailable(err), 503);
    }
    if (!member) {
      return c.json({ error: { code: 'not_found', message: 'Workspace not found' } }, 404);
    }
    c.set('userId', identity.userId);
    c.set('workspaceId', workspaceId);
    c.set('role', member.role);
    await next();
  });

/**
 * Requires a minimum role level (viewer < editor < owner).
 * Mutating routes require editor or owner; owner routes require owner. Returns 403 otherwise.
 */
export function requireRole(minRole: Role) {
  return createMiddleware(async (c, next) => {
    const role = c.get('role') as Role | undefined;
    if (!role || ROLE_RANK[role] < ROLE_RANK[minRole]) {
      return c.json({ error: { code: 'forbidden', message: 'Insufficient permissions' } }, 403);
    }
    await next();
  });
}

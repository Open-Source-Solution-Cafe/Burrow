import type { HttpError } from './services/errors';

/**
 * Account admission strategy for the Burrow instance.
 *
 * - `bootstrap-or-invite`: The initial workspace setup requires the instance bootstrap token.
 *   Subsequent accounts may only register if they hold a valid invite token.
 * - `open`: Any visitor may create an account and immediately provision a new workspace
 *   without requiring a bootstrap token or invite.
 */
export type SignupMode = 'bootstrap-or-invite' | 'open';

/**
 * Discriminative context passed into access policy authorization hooks.
 */
export type PolicyContext =
  | { action: 'workspace.create'; userId: string }
  | { action: 'project.create' | 'member.add' | 'invite.create'; userId: string; workspaceId: string }
  | { action: 'file.upload'; userId: string; workspaceId: string; bytes: number };

/**
 * Access policy contract governing account signup, quota enforcement, and permission checks.
 */
export interface AccessPolicy {
  /**
   * Defines how the sign-up route admits new accounts.
   *
   * @returns `bootstrap-or-invite` for locked self-hosted setups, or `open` for open registration.
   */
  signupMode(): SignupMode;

  /**
   * Authorize a proposed domain action within the given policy context.
   *
   * @param ctx Discriminative policy context identifying the actor, action, and target parameters.
   * @throws {HttpError} Throws `httpError(402, ...)` or `httpError(403, ...)` to refuse the action.
   *                     Resolves peacefully to allow the action.
   */
  authorize(ctx: PolicyContext): Promise<void>;

  /**
   * Optional mapper for database-enforced quota errors (e.g. trigger violations or constraint failures)
   * into clean, typed HttpError instances.
   *
   * @param error Any thrown error during route or transaction execution.
   * @returns An `HttpError` if the error maps to a known quota/policy violation, or `null` otherwise.
   */
  mapError?(error: unknown): HttpError | null;
}

/**
 * Default self-hosted access policy.
 *
 * Implements standard Burrow open-source behavior:
 * - Requires bootstrap token for the initial account, invites thereafter (`bootstrap-or-invite`).
 * - Permits all domain actions without quota constraints.
 * - No custom database error mappings.
 */
export class SelfHostedPolicy implements AccessPolicy {
  signupMode(): SignupMode {
    return 'bootstrap-or-invite';
  }

  async authorize(_ctx: PolicyContext): Promise<void> {
    // Self-hosted edition allows all operations by default
  }

  mapError(_error: unknown): HttpError | null {
    return null;
  }
}

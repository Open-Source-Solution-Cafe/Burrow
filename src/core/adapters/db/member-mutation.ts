import { sql } from 'drizzle-orm';
import type { ChangeRoleArgs, RemoveMemberArgs } from '../../infrastructure/types';

/** Shared SQL policy; both adapters evaluate current memberships inside their commit boundary. */
export function memberMutationError(args: ChangeRoleArgs | RemoveMemberArgs) {
  const removing = !('newRole' in args);
  const ownerRequired =
    removing && args.actorUserId === args.targetUserId ? sql`` : sql`AND role = 'owner'`;
  const ownerLoss = removing || args.newRole !== 'owner';
  return sql<string | null>`CASE
    WHEN NOT EXISTS (SELECT 1 FROM members
      WHERE workspace_id = ${args.workspaceId} AND user_id = ${args.actorUserId} ${ownerRequired})
      THEN 'forbidden'
    WHEN NOT EXISTS (SELECT 1 FROM members
      WHERE workspace_id = ${args.workspaceId} AND user_id = ${args.targetUserId})
      THEN 'not_found'
    ${
      ownerLoss
        ? sql`WHEN EXISTS (SELECT 1 FROM members
      WHERE workspace_id = ${args.workspaceId} AND user_id = ${args.targetUserId} AND role = 'owner')
      AND NOT EXISTS (SELECT 1 FROM members WHERE workspace_id = ${args.workspaceId}
        AND user_id <> ${args.targetUserId} AND role = 'owner')
      THEN ${removing ? 'cannot_remove_last_owner' : 'cannot_demote_last_owner'}`
        : sql``
    }
    ELSE NULL END`;
}

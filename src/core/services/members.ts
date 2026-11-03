import type {
  IMemberRepository,
  Member,
  ChangeRoleArgs,
  RemoveMemberArgs,
} from '../infrastructure/types';
import { notFound, badRequest, forbidden } from './errors';

export type { ChangeRoleArgs, RemoveMemberArgs } from '../infrastructure/types';

export class MemberService {
  constructor(private readonly repos: { members: IMemberRepository }) {}

  async listMembers(workspaceId: string): Promise<Member[]> {
    return this.repos.members.listByWorkspace(workspaceId);
  }

  async changeRole(args: ChangeRoleArgs): Promise<void> {
    await this.repos.members.updateRole(args).catch(mapMemberError);
  }

  async removeMember(args: RemoveMemberArgs): Promise<void> {
    await this.repos.members.remove(args).catch(mapMemberError);
  }
}

function mapMemberError(error: unknown): never {
  if (error instanceof Error) {
    switch (error.message) {
      case 'not_found':
        throw notFound('not_found', 'Member not found');
      case 'forbidden':
        throw forbidden('forbidden', 'Insufficient permissions');
      case 'cannot_demote_last_owner':
        throw badRequest(error.message, 'Cannot demote the last owner of the workspace');
      case 'cannot_remove_last_owner':
        throw badRequest(error.message, 'Cannot remove the last owner of the workspace');
    }
  }
  throw error;
}

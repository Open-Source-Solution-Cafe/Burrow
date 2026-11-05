import { nanoid } from 'nanoid';
import type {
  IInviteRepository,
  IMemberRepository,
  IWorkspaceRepository,
  Invite,
  CreateInviteData,
} from '../infrastructure/types';
import { notFound, badRequest } from './errors';
import { hashToken } from '../shared/crypto';
import type { AccessPolicy } from '../policy';

const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;

export class InviteService {
  constructor(
    private readonly repos: {
      invites: IInviteRepository;
      members: IMemberRepository;
      workspaces: IWorkspaceRepository;
    },
    private readonly policy?: AccessPolicy,
  ) {}

  async createInvite(
    workspaceId: string,
    userId: string,
    email: string,
    role: 'editor' | 'viewer',
  ): Promise<{ invite: Invite; token: string; url: string }> {
    await this.policy?.authorize({
      action: 'invite.create',
      userId,
      workspaceId,
    });
    const rawToken = nanoid(32);
    const tokenHash = await hashToken(rawToken);
    const id = nanoid();
    const now = Date.now();
    const expiresAt = now + SEVEN_DAYS_MS;

    const invite: CreateInviteData = {
      id,
      workspaceId,
      email,
      role,
      tokenHash,
      invitedBy: userId,
      expiresAt,
      createdAt: now,
    };

    await this.repos.invites.create(invite);

    return {
      invite: { ...invite, acceptedAt: null },
      token: rawToken,
      url: '', // URL constructed by caller with origin
    };
  }

  async listPendingInvites(workspaceId: string): Promise<Invite[]> {
    return this.repos.invites.listPending(workspaceId);
  }

  async getInviteInfo(
    token: string,
  ): Promise<Invite & { workspaceName: string; userExists: boolean }> {
    const tokenHash = await hashToken(token);
    const invite = await this.repos.invites.findByTokenHash(tokenHash);
    if (!invite) throw notFound('invalid_invite', 'Invalid or expired invite');

    const now = Date.now();
    if (invite.acceptedAt !== null) {
      throw badRequest('invite_already_accepted', 'This invite has already been accepted');
    }
    if (invite.expiresAt <= now) {
      throw badRequest('invite_expired', 'This invite has expired');
    }

    // Fetch workspace name from workspace repository
    const workspace = await this.repos.workspaces.findById(invite.workspaceId);
    const workspaceName = workspace?.name ?? 'Workspace';

    // Check if the invited email belongs to an existing user account
    const userExists = await this.repos.members.userExists(invite.email);

    return { ...invite, workspaceName, userExists };
  }

  async deleteInvite(workspaceId: string, inviteId: string): Promise<void> {
    await this.repos.invites.delete(inviteId, workspaceId);
  }

  async acceptInvite(
    userId: string,
    token: string,
  ): Promise<{ workspaceId: string; role: 'owner' | 'editor' | 'viewer' }> {
    const tokenHash = await hashToken(token);
    const invite = await this.repos.invites.findByTokenHash(tokenHash);
    if (!invite || invite.acceptedAt !== null || invite.expiresAt <= Date.now()) {
      throw badRequest('invalid_invite', 'Invalid or expired invite');
    }

    await this.policy?.authorize({
      action: 'member.add',
      userId,
      workspaceId: invite.workspaceId,
    });

    const result = await this.repos.invites.acceptForUser(
      tokenHash,
      userId,
      Date.now(),
    );
    if (!result) throw badRequest('invalid_invite', 'Invalid or expired invite');
    return result;
  }
}

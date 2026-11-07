import { describe, it, expect, vi } from 'vitest';
import { MemberService } from '../../src/core/services/members';
import type { IMemberRepository, Member } from '../../src/core/infrastructure/types';

describe('MemberService - Last Owner Guards', () => {
  const createMockRepo = (overrides: Partial<IMemberRepository> = {}): IMemberRepository => ({
    listByWorkspace: vi.fn().mockResolvedValue([]),
    findByUserId: vi.fn().mockResolvedValue(null),
    findByUserIds: vi.fn().mockResolvedValue([]),
    findByPattern: vi.fn().mockResolvedValue([]),
    updateRole: vi.fn().mockResolvedValue(undefined),
    remove: vi.fn().mockResolvedValue(undefined),
    create: vi.fn().mockResolvedValue({} as Member),
    userExists: vi.fn().mockResolvedValue(true),
    ...overrides,
  });

  describe('removeMember', () => {
    it('blocks removing the last owner with cannot_remove_last_owner', async () => {
      const repo = createMockRepo({
        remove: vi.fn().mockRejectedValue(new Error('cannot_remove_last_owner')),
      });
      const service = new MemberService({ members: repo });

      await expect(
        service.removeMember({
          workspaceId: 'ws-1',
          actorUserId: 'user-1',
          targetUserId: 'user-1',
        }),
      ).rejects.toMatchObject({
        status: 400,
        code: 'cannot_remove_last_owner',
      });
    });

    it('allows removing a member when they are not the last owner', async () => {
      const repo = createMockRepo({
        remove: vi.fn().mockResolvedValue(undefined),
      });
      const service = new MemberService({ members: repo });

      await expect(
        service.removeMember({
          workspaceId: 'ws-1',
          actorUserId: 'owner-1',
          targetUserId: 'editor-1',
        }),
      ).resolves.toBeUndefined();
    });
  });

  describe('assertCanDeleteUser', () => {
    it('blocks user deletion when the user is the sole owner of a workspace', async () => {
      const membersRepo = createMockRepo({
        listByWorkspace: vi.fn().mockResolvedValue([
          { userId: 'user-sole-owner', role: 'owner' },
          { userId: 'user-editor', role: 'editor' },
        ] as Member[]),
      });
      const workspaceRepo = {
        listByUser: vi.fn().mockResolvedValue([
          { id: 'ws-sole', role: 'owner' },
        ]),
      };

      const service = new MemberService({ members: membersRepo });

      await expect(
        service.assertCanDeleteUser('user-sole-owner', workspaceRepo),
      ).rejects.toMatchObject({
        status: 400,
        code: 'cannot_delete_sole_owner',
      });
    });

    it('allows user deletion when another owner exists in the workspace', async () => {
      const membersRepo = createMockRepo({
        listByWorkspace: vi.fn().mockResolvedValue([
          { userId: 'user-co-owner', role: 'owner' },
          { userId: 'other-owner', role: 'owner' },
        ] as Member[]),
      });
      const workspaceRepo = {
        listByUser: vi.fn().mockResolvedValue([
          { id: 'ws-shared', role: 'owner' },
        ]),
      };

      const service = new MemberService({ members: membersRepo });

      await expect(
        service.assertCanDeleteUser('user-co-owner', workspaceRepo),
      ).resolves.toBeUndefined();
    });

    it('allows user deletion when the user is only an editor or viewer', async () => {
      const membersRepo = createMockRepo();
      const workspaceRepo = {
        listByUser: vi.fn().mockResolvedValue([
          { id: 'ws-editor', role: 'editor' },
          { id: 'ws-viewer', role: 'viewer' },
        ]),
      };

      const service = new MemberService({ members: membersRepo });

      await expect(
        service.assertCanDeleteUser('user-editor-only', workspaceRepo),
      ).resolves.toBeUndefined();
    });
  });
});


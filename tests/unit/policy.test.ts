import { describe, expect, it } from 'vitest';
import { SelfHostedPolicy, type PolicyContext } from '../../src/core/policy';

describe('SelfHostedPolicy', () => {
  const policy = new SelfHostedPolicy();

  it('defaults to bootstrap-or-invite signup mode', () => {
    expect(policy.signupMode()).toBe('bootstrap-or-invite');
  });

  it('permits all policy actions unconditionally', async () => {
    const contexts: PolicyContext[] = [
      { action: 'workspace.create', userId: 'user-1' },
      { action: 'project.create', userId: 'user-1', workspaceId: 'ws-1' },
      { action: 'member.add', userId: 'user-1', workspaceId: 'ws-1' },
      { action: 'invite.create', userId: 'user-1', workspaceId: 'ws-1' },
      { action: 'file.upload', userId: 'user-1', workspaceId: 'ws-1', bytes: 1024 * 1024 },
    ];

    for (const ctx of contexts) {
      await expect(policy.authorize(ctx)).resolves.toBeUndefined();
    }
  });

  it('returns null for error mapping', () => {
    expect(policy.mapError(new Error('random failure'))).toBeNull();
    expect(policy.mapError({ code: 'SQLITE_CONSTRAINT' })).toBeNull();
    expect(policy.mapError(null)).toBeNull();
  });

  it('permits self-update by default in self-hosted deployments', () => {
    expect(policy.allowSelfUpdate()).toBe(true);
  });
});

import { describe, expect, it, vi } from 'vitest';
import { ProjectService } from './projects';

describe('project deletion upload policy cleanup', () => {
  it('removes only the deleted project policy after the guarded delete succeeds', async () => {
    const remove = vi.fn(async () => {});
    const guardedDelete = vi.fn(async () => []);
    const service = new ProjectService({
      projects: { findByIdAndWorkspace: async () => ({ name: 'Project' }), hardDeleteGuarded: guardedDelete },
      members: { findByUserId: async () => ({ role: 'owner' }) },
    } as never, { delete: remove } as never);
    const args = { workspaceId: 'w', projectId: 'p', actorUserId: 'u', confirmName: 'Project' };
    await service.permanentDeleteProject(args);
    expect(remove).toHaveBeenCalledExactlyOnceWith('w/p/.upload-policy.json');
    remove.mockClear();
    guardedDelete.mockRejectedValueOnce(new Error('database unavailable'));
    await expect(service.permanentDeleteProject(args)).rejects.toThrow('database unavailable');
    expect(remove).not.toHaveBeenCalled();
  });
});

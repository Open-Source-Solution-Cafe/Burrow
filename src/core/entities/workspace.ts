import type { WorkspaceProvisioningPlan } from '../infrastructure/types';

/** Deterministic starter rows shared by bootstrap and authenticated provisioning. */
export function createWorkspacePlan({
  userId,
  name,
  workspaceId,
  projectId,
  notepadId,
  now,
}: {
  userId: string;
  name: string;
  workspaceId: string;
  projectId: string;
  notepadId: string;
  now: number;
}): WorkspaceProvisioningPlan {
  return {
    workspace: { id: workspaceId, name, createdBy: userId, createdAt: now },
    owner: { workspaceId, userId, role: 'owner', joinedAt: now },
    project: {
      id: projectId,
      workspaceId,
      name: 'My first project',
      icon: null,
      color: null,
      position: 'a0',
      createdAt: now,
      updatedAt: now,
    },
    notepad: {
      id: notepadId,
      workspaceId,
      projectId,
      parentId: null,
      kind: 'notepad',
      title: 'Welcome to Burrow',
      content: '[]',
      version: 1,
      position: 'a0',
      isFavorite: false,
      createdBy: userId,
      createdAt: now,
      updatedAt: now,
    },
  };
}

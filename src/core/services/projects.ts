import { nanoid } from 'nanoid';
import { uploadPolicyStorageKey } from '../../shared/uploadPolicy';
import type {
  IProjectRepository,
  INotepadRepository,
  IProjectFileRepository,
  IMemberRepository,
  Project,
  UpdateProjectData,
} from '../infrastructure/types';
import { notFound, badRequest, forbidden, conflict } from './errors';
import { positionAfterLast, positionBetween } from './utils/ordering';
import type { IStorageAdapter } from '../adapters/storage/types';
import type { AccessPolicy } from '../policy';

export interface CreateProjectArgs {
  workspaceId: string;
  actorUserId: string;
  name: string;
  icon?: string | null;
  color?: string | null;
}

export interface UpdateProjectArgs {
  workspaceId: string;
  actorUserId: string;
  projectId: string;
  name?: string;
  icon?: string | null;
  color?: string | null;
  archived?: boolean;
}

export interface MoveProjectArgs {
  workspaceId: string;
  actorUserId: string;
  projectId: string;
  afterId?: string | null;
}

export interface PermanentDeleteProjectArgs {
  workspaceId: string;
  actorUserId: string;
  projectId: string;
  confirmName: string;
}

export type Repositories = {
  projects: IProjectRepository;
  notepads: INotepadRepository;
  members: IMemberRepository;
  projectFiles: IProjectFileRepository;
};

export class ProjectService {
  constructor(
    private readonly repos: Repositories,
    private readonly storage?: IStorageAdapter,
    private readonly policy?: AccessPolicy,
  ) {}

  async listProjects(workspaceId: string): Promise<Project[]> {
    return this.repos.projects.listByWorkspace(workspaceId);
  }

  private async requireEditor(workspaceId: string, actorUserId: string): Promise<void> {
    const member = await this.repos.members.findByUserId(workspaceId, actorUserId);
    if (!member || member.role === 'viewer')
      throw forbidden('forbidden', 'Insufficient permissions');
  }

  async createProject(args: CreateProjectArgs): Promise<{ id: string; position: string }> {
    await this.policy?.authorize({
      action: 'project.create',
      userId: args.actorUserId,
      workspaceId: args.workspaceId,
    });
    const id = nanoid();
    const now = Date.now();
    for (let attempt = 0; attempt < 4; attempt++) {
      const rows = await this.repos.projects.listByWorkspace(args.workspaceId);
      const last = rows.at(-1) ?? null;
      const position = positionAfterLast(last?.position ?? null);
      const created = await this.repos.projects.createGuarded(
        {
          id,
          workspaceId: args.workspaceId,
          name: args.name.trim() || 'Untitled Project',
          icon: args.icon ?? null,
          color: args.color ?? null,
          position,
          createdAt: now,
          updatedAt: now,
        },
        args.actorUserId,
        last && { id: last.id, position: last.position },
      );
      if (created) return { id, position };
      await this.requireEditor(args.workspaceId, args.actorUserId);
    }
    throw conflict('project_order_changed', 'Project order changed; please try again');
  }

  async updateProject(args: UpdateProjectArgs): Promise<void> {
    const project = await this.repos.projects.findByIdAndWorkspace(
      args.projectId,
      args.workspaceId,
    );
    if (!project) throw notFound('not_found', 'Project not found');

    const updates: UpdateProjectData = { updatedAt: Date.now() };
    if (args.name !== undefined) updates.name = args.name.trim() || 'Untitled Project';
    if (args.icon !== undefined) updates.icon = args.icon;
    if (args.color !== undefined) updates.color = args.color;
    if (args.archived !== undefined) {
      updates.archivedAt = args.archived ? Date.now() : null;
    }

    if (
      !(await this.repos.projects.updateGuarded(
        args.workspaceId,
        args.actorUserId,
        args.projectId,
        updates,
      ))
    ) {
      await this.requireEditor(args.workspaceId, args.actorUserId);
      if (!(await this.repos.projects.findByIdAndWorkspace(args.projectId, args.workspaceId)))
        throw notFound('not_found', 'Project not found');
      throw conflict('project_changed', 'Project changed; please try again');
    }
  }

  async moveProject(args: MoveProjectArgs): Promise<{ position: string }> {
    for (let attempt = 0; attempt < 4; attempt++) {
      const project = await this.repos.projects.findByIdAndWorkspace(
        args.projectId,
        args.workspaceId,
      );
      if (!project) throw notFound('not_found', 'Project not found');
      const others = (await this.repos.projects.listByWorkspace(args.workspaceId)).filter(
        (p) => p.id !== args.projectId,
      );
      const afterIndex = args.afterId ? others.findIndex((p) => p.id === args.afterId) : -1;
      if (args.afterId && afterIndex === -1)
        throw badRequest('invalid_after_id', 'afterId not found');
      const previous = afterIndex < 0 ? null : others[afterIndex]!;
      const next = others[afterIndex + 1] ?? null;
      if (previous && next && previous.position >= next.position)
        throw conflict('project_order_changed', 'Project order requires repair');
      const position = positionBetween(previous?.position ?? null, next?.position ?? null);
      const moved = await this.repos.projects.moveGuarded(
        args.workspaceId,
        args.actorUserId,
        args.projectId,
        position,
        {
          targetPosition: project.position,
          previous: previous && { id: previous.id, position: previous.position },
          next: next && { id: next.id, position: next.position },
        },
      );
      if (moved) return { position };
      await this.requireEditor(args.workspaceId, args.actorUserId);
    }
    throw conflict('project_order_changed', 'Project order changed; please try again');
  }

  async permanentDeleteProject(args: PermanentDeleteProjectArgs): Promise<void> {
    const project = await this.repos.projects.findByIdAndWorkspace(
      args.projectId,
      args.workspaceId,
    );
    if (!project) throw notFound('not_found', 'Project not found');

    if (project.name !== args.confirmName) {
      throw badRequest('name_mismatch', 'Project confirmation name does not match');
    }

    const member = await this.repos.members.findByUserId(args.workspaceId, args.actorUserId);
    if (!member || member.role !== 'owner') {
      throw forbidden('forbidden', 'Only workspace owners can permanently delete a project');
    }

    let coverKeys: string[] | null;
    try {
      coverKeys = await this.repos.projects.hardDeleteGuarded(
        args.workspaceId,
        args.actorUserId,
        args.projectId,
        args.confirmName,
      );
    } catch (error) {
      if (error instanceof Error && error.message === 'project_scope_conflict') {
        throw conflict(
          'project_scope_conflict',
          'Project content has inconsistent workspace or parent relationships and needs repair',
        );
      }
      throw error;
    }
    if (!coverKeys) {
      const current = await this.repos.projects.findByIdAndWorkspace(
        args.projectId,
        args.workspaceId,
      );
      if (!current) throw notFound('not_found', 'Project not found');
      if (current.name !== args.confirmName) {
        throw conflict('project_delete_changed', 'Project changed before it could be deleted');
      }
      const currentMember = await this.repos.members.findByUserId(
        args.workspaceId,
        args.actorUserId,
      );
      if (!currentMember || currentMember.role !== 'owner') {
        throw forbidden('forbidden', 'Only workspace owners can permanently delete a project');
      }
      throw conflict('project_delete_changed', 'Project changed before it could be deleted');
    }

    if (this.storage) {
      await this.storage.delete(uploadPolicyStorageKey(args.workspaceId, args.projectId))
        .catch((error) => console.error('[projects] failed to clean up upload policy:', error));
    }
    if (this.storage && coverKeys.length > 0) {
      await Promise.allSettled(
        Array.from(new Set(coverKeys)).map(async (key) => {
          const [registrations, covers] = await Promise.all([
            this.repos.projectFiles.countByStorageKey(key),
            this.repos.notepads.countByCoverKey(key),
          ]);
          if (registrations === 0 && covers === 0) {
            await this.storage!.delete(key);
          }
        }),
      );
    }
  }
}

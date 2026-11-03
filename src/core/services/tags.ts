import { nanoid } from 'nanoid';
import type { ITagRepository, Tag, CreateTagData, TagMutationScope, ProjectScope } from '../infrastructure/types';
import { forbidden, notFound } from './errors';

export class TagService {
  constructor(private readonly repos: { tags: ITagRepository }) {}

  async listTags(scope: ProjectScope): Promise<Tag[]> {
    return this.repos.tags.listByProject(scope);
  }

  async createTag(
    workspaceId: string,
    projectId: string,
    actorUserId: string,
    name: string,
    color?: string | null,
  ): Promise<Tag> {
    const scope: TagMutationScope = { workspaceId, projectId, actorUserId, minimumRole: 'editor' };

    // Check if tag already exists for this project
    const existing = await this.repos.tags.findByName({ workspaceId, projectId }, name.trim());
    if (existing) {
      return existing;
    }

    const id = nanoid();
    const newTag: CreateTagData = {
      id,
      projectId,
      name: name.trim(),
      color: color ?? null,
    };

    const created = await this.repos.tags.createGuarded(newTag, scope);
    if (!created) throw forbidden('forbidden', 'Editor access changed while creating the tag');
    return created;
  }

  async updateTag(
    scope: TagMutationScope,
    tagId: string,
    updates: { name?: string; color?: string | null },
  ): Promise<Tag> {
    const tag = await this.repos.tags.findByIdInScope(scope, tagId);
    if (!tag) throw notFound('not_found', 'Tag not found');

    const written = await this.repos.tags.updateGuarded(tagId, {
      name: updates.name ? updates.name.trim() : undefined,
      color: updates.color !== undefined ? updates.color : undefined,
    }, scope);
    if (!written) throw forbidden('forbidden', 'Editor access changed while updating the tag');

    const updated = await this.repos.tags.findByIdInScope(scope, tagId);
    if (!updated) throw notFound('not_found', 'Tag not found after update');
    return updated;
  }

  async deleteTag(scope: TagMutationScope, tagId: string): Promise<void> {
    const tag = await this.repos.tags.findByIdInScope(scope, tagId);
    if (!tag) throw notFound('not_found', 'Tag not found');

    if (!(await this.repos.tags.deleteGuarded(tagId, scope))) throw forbidden('forbidden', 'Editor access changed while deleting the tag');
  }
}

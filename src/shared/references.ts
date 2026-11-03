import type { LinkTargetType } from './blocks';

export type ContentReferenceKind = Exclude<LinkTargetType, 'user'>;

/** Read-only preview resolved against the source document's project. */
export interface ReferencePreview {
  kind: ContentReferenceKind;
  id: string;
  workspaceId: string;
  projectId: string;
  title: string;
  icon?: string | null;
  boardId?: string;
  boardName?: string;
  columnName?: string;
  priority?: string | null;
}

/** Build destinations from a resolved target, never from a document's unverified ID. */
export function referenceHref(reference: ReferencePreview): string | null {
  if (!reference.projectId || !reference.id) return null;
  const project = `/p/${encodeURIComponent(reference.projectId)}`;
  const id = encodeURIComponent(reference.id);
  if (reference.kind === 'notepad') return `${project}/notepads/${id}`;
  if (reference.kind === 'board') return `${project}/boards/${id}`;
  return reference.boardId
    ? `${project}/boards/${encodeURIComponent(reference.boardId)}?cardId=${id}`
    : null;
}

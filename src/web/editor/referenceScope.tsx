import { createContext, useContext } from 'react';
import { useQuery } from '@tanstack/react-query';
import type { ContentReferenceKind, ReferencePreview } from '../../shared/references';
import { useAccount } from '../lib/queries';
import { projectApiPath } from '../lib/workspaceRoutes';

const ReferenceScope = createContext<Pick<ReferencePreview, 'workspaceId' | 'projectId'> | null>(
  null,
);
export const ReferenceScopeProvider = ReferenceScope.Provider;

/** Bind reads to the verified source document, including card/task overlays. */
export function useProjectReference(kind: ContentReferenceKind, id: string) {
  const scope = useContext(ReferenceScope);
  const { data: account } = useAccount();
  const result = useQuery({
    queryKey: ['reference', account?.user.id, scope?.workspaceId, scope?.projectId, kind, id],
    enabled: Boolean(scope && account?.user.id && id),
    retry: false,
    queryFn: async ({ signal }) => {
      if (!scope) throw new Error('Reference unavailable');
      const response = await fetch(
        projectApiPath(scope.workspaceId, scope.projectId, `references/${kind}/${id}`),
        { signal },
      );
      if (!response.ok) throw new Error('Reference unavailable');
      const preview = await response.json();
      if (preview.workspaceId !== scope.workspaceId || preview.projectId !== scope.projectId) {
        throw new Error('Reference unavailable');
      }
      return preview;
    },
  });
  return { ...result, data: result.isError ? undefined : result.data };
}

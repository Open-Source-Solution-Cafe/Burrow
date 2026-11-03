import { projectApiPath } from '../lib/workspaceRoutes';
import { getUploadFileType, type UploadPolicy } from '../../shared/uploadPolicy';

/** Capture the insertion project's scope so a delayed upload cannot follow navigation. */
export function createMediaUploader(
  { workspaceId, projectId }: { workspaceId: string; projectId: string },
  reportError: (message: string) => void,
  policy?: UploadPolicy,
): (file: File) => Promise<string> {
  const uploadPath = projectApiPath(workspaceId, projectId, 'uploads');
  const filePrefix = `${projectApiPath(workspaceId, projectId, 'files')}/`;
  return async (file) => {
    try {
      if (policy) {
        const type = getUploadFileType(file);
        if (!type || !policy.allowedMimeTypes.includes(type.mimeType)) {
          throw new Error('This file type is not allowed by the project upload settings');
        }
        if (file.size > policy.maxFileSizeBytes) {
          throw new Error(`File exceeds the ${policy.maxFileSizeBytes / (1024 * 1024)} MB upload limit`);
        }
      }
      const form = new FormData();
      form.append('file', file);
      const response = await fetch(uploadPath, { method: 'POST', body: form });
      const result = (await response.json().catch(() => null)) as {
        url?: unknown;
        error?: { message?: string };
        message?: string;
      } | null;
      if (!response.ok) {
        throw new Error(result?.error?.message || result?.message || 'Media upload failed');
      }
      if (typeof result?.url !== 'string' || !result.url) {
        throw new Error('Upload returned an invalid file URL');
      }
      const url = new URL(result.url, 'https://burrow.invalid');
      if (!['http:', 'https:'].includes(url.protocol) || !url.pathname.startsWith(filePrefix)) {
        throw new Error('Upload returned a file outside this project');
      }
      return `${url.pathname}${url.search}`;
    } catch (error) {
      const failure = error instanceof Error ? error : new Error('Media upload failed');
      reportError(failure.message);
      throw failure;
    }
  };
}

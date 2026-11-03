import { Hono } from 'hono';
import { createMiddleware } from 'hono/factory';
import type { Env } from '../app';
import type {
  IProjectRepository,
  IProjectFileRepository,
  IMemberRepository,
} from '../infrastructure/types';
import type { IStorageAdapter } from '../adapters/storage';
import { validateStorageKey } from '../adapters/storage/validation';
import { isAllowedImageContent } from '../shared/image-validation';
import { isAllowedFileContent } from '../shared/file-validation';
import { createExplicitWorkspaceMiddleware, requireRole } from '../middleware/session';
import { httpError } from '../services/errors';
import { nanoid } from 'nanoid';
import { z } from 'zod';
import { DEFAULT_UPLOAD_POLICY, MAX_UPLOAD_BYTES, UPLOAD_FILE_TYPES, getUploadFileType, uploadPolicyStorageKey } from '../../shared/uploadPolicy';

const policySchema = z.object({
  maxFileSizeBytes: z.number().int().min(1).max(MAX_UPLOAD_BYTES),
  allowedMimeTypes: z.array(z.string().refine((mime) => UPLOAD_FILE_TYPES.some((type) => type.mimeType === mime))).max(UPLOAD_FILE_TYPES.length),
}).strict();

export function createProjectFileRoutes(args: {
  projects: IProjectRepository;
  members: IMemberRepository;
  files: IProjectFileRepository;
  storage: IStorageAdapter;
}) {
  const { projects, members, files, storage } = args;
  const route = new Hono<Env>();
  const explicitWorkspace = createExplicitWorkspaceMiddleware(members);
  const readPolicy = async (workspaceId: string, projectId: string) => {
    const object = await storage.get(uploadPolicyStorageKey(workspaceId, projectId));
    if (!object) return DEFAULT_UPLOAD_POLICY;
    return policySchema.parse(await new Response(object.body as BodyInit).json());
  };
  const explicitProject = createMiddleware<Env>(async (c, next) => {
    const projectId = c.req.param('pid');
    if (!projectId) throw httpError(404, 'not_found', 'Project not found');
    const project = await projects.findByIdAndWorkspace(projectId, c.get('workspaceId'));
    if (!project) throw httpError(404, 'not_found', 'Project not found');
    await next();
  });

  const sendFile = async (key: string, contentType: string) => {
    const object = await storage.get(key);
    if (!object) throw httpError(404, 'not_found', 'File not found');
    const headers = new Headers({
      'Content-Type': object.contentType || contentType || 'application/octet-stream',
      'Cache-Control': 'private, no-store',
      'X-Content-Type-Options': 'nosniff',
    });
    if ((object.contentType || contentType) === 'image/svg+xml') {
      headers.set('Content-Security-Policy', 'sandbox');
    }
    if (!/^(image|audio|video)\//.test(contentType)) headers.set('Content-Disposition', 'attachment');
    return new Response(object.body as any, { headers });
  };

  route.get('/workspaces/:wid/projects/:pid/upload-policy', explicitWorkspace, explicitProject, async (c) => {
    c.header('Cache-Control', 'private, no-store');
    return c.json(await readPolicy(c.get('workspaceId'), c.req.param('pid')));
  });
  route.patch('/workspaces/:wid/projects/:pid/upload-policy', explicitWorkspace, explicitProject, requireRole('owner'), async (c) => {
    const parsed = policySchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) throw httpError(400, 'invalid_upload_policy', 'Choose supported file types and a size between 1 byte and 100 MB');
    const policy = { ...parsed.data, allowedMimeTypes: [...new Set(parsed.data.allowedMimeTypes)] };
    await storage.put(uploadPolicyStorageKey(c.get('workspaceId'), c.req.param('pid')), new TextEncoder().encode(JSON.stringify(policy)), 'application/json');
    return c.json(policy);
  });

  route.post(
    '/workspaces/:wid/projects/:pid/uploads',
    explicitWorkspace,
    explicitProject,
    requireRole('editor'),
    async (c) => {
      const body = await c.req.parseBody();
      const file = body['file'];
      if (!file || !(file instanceof File)) {
        throw httpError(400, 'invalid_file', 'No file provided in form field "file"');
      }
      const policy = await readPolicy(c.get('workspaceId'), c.req.param('pid'));
      const fileType = getUploadFileType(file);
      if (!fileType || !policy.allowedMimeTypes.includes(fileType.mimeType)) {
        throw httpError(400, 'invalid_mime_type', `File type ${file.type} not allowed`);
      }
      if (file.size > policy.maxFileSizeBytes) {
        throw httpError(413, 'payload_too_large', `File exceeds the project's ${policy.maxFileSizeBytes / (1024 * 1024)} MB limit`);
      }

      const workspaceId = c.get('workspaceId');
      const projectId = c.req.param('pid');
      const key = `${workspaceId}/${projectId}/${nanoid()}.${fileType.extension}`;
      const bytes = new Uint8Array(await file.arrayBuffer());
      if (fileType.mimeType.startsWith('image/') && !isAllowedImageContent(fileType.mimeType, bytes)) {
        throw httpError(
          400,
          'invalid_image_content',
          'File content does not match the declared image type',
        );
      }
      if (!fileType.mimeType.startsWith('image/') && !isAllowedFileContent(fileType.mimeType, bytes)) {
        throw httpError(400, 'invalid_file_content', 'File content does not match the selected file type');
      }
      await storage.put(key, bytes, fileType.mimeType);
      try {
        const registered = await files.register({
          projectId,
          storageKey: key,
          contentType: fileType.mimeType,
          filename: file.name,
          byteSize: file.size,
          createdBy: c.get('userId'),
          createdAt: Date.now(),
        });
        if (!registered) throw httpError(409, 'file_conflict', 'File key is already registered');
      } catch (error) {
        if ((await files.countByStorageKey(key)) === 0) {
          await storage
            .delete(key)
            .catch((cleanupError) =>
              console.error('[files] failed to clean up unregistered upload:', cleanupError),
            );
        }
        throw error;
      }

      const origin = new URL(c.req.url).origin;
      const url = `${origin}/api/workspaces/${encodeURIComponent(workspaceId)}/projects/${encodeURIComponent(projectId)}/files/${encodeURIComponent(key)}`;
      c.header('Cache-Control', 'private, no-store');
      return c.json({ key, url });
    },
  );

  route.get(
    '/workspaces/:wid/projects/:pid/media',
    explicitWorkspace,
    explicitProject,
    async (c) => {
      const projectId = c.req.param('pid');
      const workspaceId = c.get('workspaceId');
      const keys = await files.listStorageKeysByProject(projectId);
      const registrations = await Promise.all(
        keys.map((key) => files.findByProjectAndKey(projectId, key)),
      );
      const origin = new URL(c.req.url).origin;
      // A registration can disappear between the list and metadata reads.
      return c.json(
        registrations
          .filter((file) => file !== null)
          .map((file) => ({
            key: file.storageKey,
            url: `${origin}/api/workspaces/${encodeURIComponent(workspaceId)}/projects/${encodeURIComponent(projectId)}/files/${encodeURIComponent(file.storageKey)}`,
            filename: file.filename ?? null,
            byteSize: file.byteSize ?? null,
            contentType: file.contentType,
            createdAt: file.createdAt,
          }))
          .sort(
            (left, right) =>
              right.createdAt - left.createdAt ||
              (left.key < right.key ? -1 : left.key > right.key ? 1 : 0),
          ),
      );
    },
  );

  route.get(
    '/workspaces/:wid/projects/:pid/files/:key',
    explicitWorkspace,
    explicitProject,
    async (c) => {
      let key: string;
      try {
        key = validateStorageKey(decodeURIComponent(c.req.param('key')));
      } catch (error) {
        if (error instanceof URIError) throw httpError(400, 'invalid_key', 'Invalid file key');
        throw httpError(404, 'not_found', 'File not found');
      }
      const registration = await files.findByProjectAndKey(c.req.param('pid'), key);
      if (!registration) throw httpError(404, 'not_found', 'File not found');
      return sendFile(key, registration.contentType);
    },
  );

  // Old links have no workspace or project in their URL. Resolve them only when
  // the registry identifies one project and the current account still belongs to it.
  route.get('/files/:key', async (c) => {
    const identity = c.get('identity');
    if (!identity) throw httpError(401, 'unauthorized', 'Authentication required');
    let key: string;
    try {
      key = validateStorageKey(decodeURIComponent(c.req.param('key')));
    } catch (error) {
      if (error instanceof URIError) throw httpError(400, 'invalid_key', 'Invalid file key');
      throw httpError(404, 'not_found', 'File not found');
    }
    const projectIds = await files.listProjectIdsByStorageKey(key);
    if (projectIds.length !== 1) throw httpError(404, 'not_found', 'File not found');
    const project = await projects.findByIdForMember(projectIds[0]!, identity.userId);
    if (!project) throw httpError(404, 'not_found', 'File not found');
    const registration = await files.findByProjectAndKey(project.id, key);
    if (!registration) throw httpError(404, 'not_found', 'File not found');
    return sendFile(key, registration.contentType);
  });

  route.post('/uploads', async (c) => {
    if (!c.get('identity')) throw httpError(401, 'unauthorized', 'Authentication required');
    throw httpError(410, 'explicit_scope_required', 'Upload using a workspace and project URL');
  });

  return route;
}

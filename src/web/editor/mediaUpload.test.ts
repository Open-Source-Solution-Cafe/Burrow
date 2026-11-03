import { afterEach, describe, expect, it, vi } from 'vitest';
import { createMediaUploader } from './mediaUpload';

afterEach(() => vi.unstubAllGlobals());

const file = new File(['image'], 'photo.png', { type: 'image/png' });
const fileUrl = '/api/workspaces/workspace-a/projects/project-a/files/key.png';

describe('project media uploader', () => {
  it('rejects disallowed types and oversized files before sending an upload', async () => {
    const request = vi.fn();
    vi.stubGlobal('fetch', request);
    const reportError = vi.fn();
    const upload = createMediaUploader(
      { workspaceId: 'workspace-a', projectId: 'project-a' },
      reportError,
      { allowedMimeTypes: ['application/pdf'], maxFileSizeBytes: 3 },
    );
    await expect(upload(file)).rejects.toThrow('file type is not allowed');
    await expect(upload(new File(['long document'], 'report.pdf', { type: 'application/pdf' })))
      .rejects.toThrow('upload limit');
    expect(request).not.toHaveBeenCalled();
    expect(reportError).toHaveBeenCalledTimes(2);
  });

  it('posts the original file to its captured project without overriding multipart headers', async () => {
    const request = vi.fn().mockResolvedValue(Response.json({ url: fileUrl }));
    vi.stubGlobal('fetch', request);
    const reportError = vi.fn();
    const scope = { workspaceId: 'workspace-a', projectId: 'project-a' };
    const upload = createMediaUploader(scope, reportError);
    scope.projectId = 'project-next';

    await expect(upload(file)).resolves.toBe(fileUrl);
    const [path, init] = request.mock.calls[0]!;
    expect(path).toBe('/api/workspaces/workspace-a/projects/project-a/uploads');
    expect(init.method).toBe('POST');
    expect(init.headers).toBeUndefined();
    expect(init.body.get('file')).toBe(file);
    expect(reportError).not.toHaveBeenCalled();
  });

  it('normalizes an absolute API response to a local scoped URL', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        Response.json({
          url: `https://api.example.test${fileUrl}`,
        }),
      ),
    );
    const upload = createMediaUploader(
      { workspaceId: 'workspace-a', projectId: 'project-a' },
      vi.fn(),
    );
    await expect(upload(file)).resolves.toBe(fileUrl);
  });

  it.each([
    [
      'server rejection',
      () =>
        Promise.resolve(
          Response.json({ error: { message: 'Image exceeds 5 MB limit' } }, { status: 413 }),
        ),
      'Image exceeds 5 MB limit',
    ],
    ['network failure', () => Promise.reject(new Error('Connection lost')), 'Connection lost'],
    [
      'non-JSON response',
      () => Promise.resolve(new Response('unexpected')),
      'Upload returned an invalid file URL',
    ],
    [
      'missing URL',
      () => Promise.resolve(Response.json({})),
      'Upload returned an invalid file URL',
    ],
    [
      'foreign project URL',
      () =>
        Promise.resolve(
          Response.json({ url: '/api/workspaces/workspace-a/projects/foreign/files/a' }),
        ),
      'Upload returned a file outside this project',
    ],
    [
      'unsafe URL',
      () => Promise.resolve(Response.json({ url: 'javascript:alert(1)' })),
      'Upload returned a file outside this project',
    ],
  ])('surfaces %s once and rejects the upload', async (_name, request, message) => {
    vi.stubGlobal('fetch', vi.fn(request));
    const reportError = vi.fn();
    const upload = createMediaUploader(
      { workspaceId: 'workspace-a', projectId: 'project-a' },
      reportError,
    );
    await expect(upload(file)).rejects.toThrow(message);
    expect(reportError).toHaveBeenCalledExactlyOnceWith(message);
  });
});

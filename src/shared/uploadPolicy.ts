export const MAX_UPLOAD_BYTES = 100 * 1024 * 1024;
export const uploadPolicyStorageKey = (workspaceId: string, projectId: string) => `${workspaceId}/${projectId}/.upload-policy.json`;
export const isUploadPolicyStorageKey = (key: string) => /^[^/]+\/[^/]+\/\.upload-policy\.json$/.test(key);
export const UPLOAD_FILE_TYPES = [
  { mimeType: 'image/png', extension: 'png', label: 'PNG image' },
  { mimeType: 'image/jpeg', extension: 'jpg', label: 'JPEG image' },
  { mimeType: 'image/webp', extension: 'webp', label: 'WebP image' },
  { mimeType: 'image/gif', extension: 'gif', label: 'GIF image' },
  { mimeType: 'image/svg+xml', extension: 'svg', label: 'SVG image' },
  { mimeType: 'application/pdf', extension: 'pdf', label: 'PDF document' },
  { mimeType: 'text/plain', extension: 'txt', label: 'Text file' },
  { mimeType: 'text/csv', extension: 'csv', label: 'CSV spreadsheet' },
  { mimeType: 'application/zip', extension: 'zip', label: 'ZIP archive' },
  { mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', extension: 'docx', label: 'Word document' },
  { mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', extension: 'xlsx', label: 'Excel spreadsheet' },
  { mimeType: 'application/vnd.openxmlformats-officedocument.presentationml.presentation', extension: 'pptx', label: 'PowerPoint presentation' },
  { mimeType: 'video/mp4', extension: 'mp4', label: 'MP4 video' },
  { mimeType: 'video/webm', extension: 'webm', label: 'WebM video' },
  { mimeType: 'audio/mpeg', extension: 'mp3', label: 'MP3 audio' },
  { mimeType: 'audio/ogg', extension: 'ogg', label: 'Ogg audio' },
  { mimeType: 'audio/wav', extension: 'wav', label: 'WAV audio' },
];

export interface UploadPolicy {
  maxFileSizeBytes: number;
  allowedMimeTypes: string[];
}

export const DEFAULT_UPLOAD_POLICY: UploadPolicy = {
  maxFileSizeBytes: 5 * 1024 * 1024,
  allowedMimeTypes: UPLOAD_FILE_TYPES.map((type) => type.mimeType),
};

export function getUploadFileType(file: { type: string; name: string }) {
  const extension = file.name.split('.').pop()?.toLowerCase();
  return UPLOAD_FILE_TYPES.find((type) => type.mimeType === file.type) ??
    (file.type === '' || file.type === 'application/octet-stream' || file.type === 'application/x-zip-compressed'
      ? UPLOAD_FILE_TYPES.find((type) => type.extension === extension || (type.extension === 'jpg' && extension === 'jpeg'))
      : undefined);
}

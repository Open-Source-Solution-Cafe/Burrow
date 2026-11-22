import type { PluginStorage, PluginStorageObject } from '@burrow/sdk';
import type { IStorageAdapter } from '../adapters/storage';

export class PluginStorageError extends Error {
  constructor(
    public readonly pluginId: string,
    message: string,
  ) {
    super(`Plugin "${pluginId}" storage access denied: ${message}`);
    this.name = 'PluginStorageError';
  }
}

export interface PluginStorageOptions {
  maxUploadBytes?: number;
  allowedContentTypes?: ReadonlySet<string>;
}

const DEFAULT_MAX_UPLOAD_BYTES = 5 * 1024 * 1024; // 5 MB

const DEFAULT_ALLOWED_CONTENT_TYPES = new Set<string>([
  'application/json',
  'text/plain',
  'text/csv',
  'text/markdown',
  'image/png',
  'image/jpeg',
  'image/webp',
  'image/gif',
  'application/pdf',
  'application/octet-stream',
]);

const BLOCKED_CONTENT_TYPES = new Set<string>([
  'text/html',
  'application/xhtml+xml',
  'image/svg+xml',
  'application/javascript',
  'text/javascript',
  'application/x-httpd-php',
]);

function hasControlChars(str: string): boolean {
  for (let i = 0; i < str.length; i++) {
    const code = str.charCodeAt(i);
    if (code < 0x20 || code === 0x7f) return true;
  }
  return false;
}

export function sanitizePluginStorageKey(pluginId: string, rawKey: string): string {
  if (typeof rawKey !== 'string' || !rawKey.trim()) {
    throw new PluginStorageError(pluginId, 'storage key must be a non-empty string');
  }
  if (rawKey.includes('\0') || hasControlChars(rawKey)) {
    throw new PluginStorageError(pluginId, 'null bytes and control characters are disallowed');
  }
  if (rawKey.startsWith('/') || rawKey.startsWith('\\') || /^[a-zA-Z]:/.test(rawKey)) {
    throw new PluginStorageError(pluginId, 'absolute paths are disallowed');
  }
  if (rawKey.includes('\\')) {
    throw new PluginStorageError(pluginId, 'backslashes are disallowed');
  }

  let decoded: string;
  try {
    decoded = decodeURIComponent(rawKey);
  } catch {
    throw new PluginStorageError(pluginId, 'malformed percent-encoding in storage key');
  }

  if (
    decoded.includes('..') ||
    rawKey.includes('..') ||
    decoded.includes('\0') ||
    decoded.startsWith('/') ||
    decoded.startsWith('\\')
  ) {
    throw new PluginStorageError(pluginId, 'path traversal segments are disallowed');
  }

  const segments = rawKey.split('/');
  if (segments.some((seg) => !seg || seg === '.' || seg === '..')) {
    throw new PluginStorageError(pluginId, 'empty or relative path segments are disallowed');
  }

  const prefix = `plugins/${pluginId}/`;
  return `${prefix}${rawKey}`;
}

export function createPluginStorage(
  pluginId: string,
  baseStorage: IStorageAdapter | undefined,
  options: PluginStorageOptions = {},
): PluginStorage {
  const maxBytes = options.maxUploadBytes ?? DEFAULT_MAX_UPLOAD_BYTES;
  const allowedTypes = options.allowedContentTypes ?? DEFAULT_ALLOWED_CONTENT_TYPES;
  const prefix = `plugins/${pluginId}/`;

  const ensureStorage = (): IStorageAdapter => {
    if (!baseStorage) {
      throw new PluginStorageError(pluginId, 'storage adapter is not available');
    }
    return baseStorage;
  };

  return {
    async put(key: string, data: ArrayBuffer | Uint8Array | string, contentType = 'application/octet-stream'): Promise<void> {
      const storage = ensureStorage();
      const fullKey = sanitizePluginStorageKey(pluginId, key);

      const normalizedType = contentType.split(';')[0]?.trim().toLowerCase() ?? '';
      if (!normalizedType || BLOCKED_CONTENT_TYPES.has(normalizedType) || !allowedTypes.has(normalizedType)) {
        throw new PluginStorageError(
          pluginId,
          `content type "${contentType}" is not permitted`,
        );
      }

      const bytes =
        typeof data === 'string'
          ? new TextEncoder().encode(data)
          : data instanceof ArrayBuffer
            ? new Uint8Array(data)
            : data;

      if (bytes.byteLength > maxBytes) {
        throw new PluginStorageError(
          pluginId,
          `payload exceeds maximum size of ${maxBytes} bytes`,
        );
      }

      await storage.put(fullKey, bytes, normalizedType);
    },

    async get(key: string): Promise<PluginStorageObject | null> {
      const storage = ensureStorage();
      const fullKey = sanitizePluginStorageKey(pluginId, key);
      return storage.get(fullKey);
    },

    async delete(key: string): Promise<void> {
      const storage = ensureStorage();
      const fullKey = sanitizePluginStorageKey(pluginId, key);
      await storage.delete(fullKey);
    },

    async list(): Promise<string[]> {
      const storage = ensureStorage();
      const all = await storage.listObjects();
      return all
        .filter((k) => k.startsWith(prefix))
        .map((k) => k.slice(prefix.length));
    },
  };
}

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
  maxTotalBytes?: number;
  maxObjects?: number;
  allowedContentTypes?: ReadonlySet<string>;
}

const DEFAULT_MAX_UPLOAD_BYTES = 5 * 1024 * 1024; // 5 MB
const DEFAULT_MAX_OBJECTS = 1_000;
const BLOCKED_EXTENSIONS = new Set<string>([
  'svg',
  'svgz',
  'html',
  'htm',
  'xhtml',
  'js',
  'mjs',
  'cjs',
  'php',
  'xml',
  'swf',
]);

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
  const maxObjects = options.maxObjects ?? DEFAULT_MAX_OBJECTS;
  const maxTotalBytes = options.maxTotalBytes ?? Math.min(50 * 1024 * 1024, maxBytes * 10);
  const allowedTypes = options.allowedContentTypes ?? DEFAULT_ALLOWED_CONTENT_TYPES;
  const prefix = `plugins/${pluginId}/`;
  const cachedSizes = new Map<string, number>();

  const ensureStorage = (): IStorageAdapter => {
    if (!baseStorage) {
      throw new PluginStorageError(pluginId, 'storage adapter is not available');
    }
    return baseStorage;
  };

  const hasDisallowedContentSignature = (bytes: Uint8Array): boolean => {
    const head = new TextDecoder()
      .decode(bytes.subarray(0, 512))
      .trimStart()
      .toLowerCase();
    return (
      head.startsWith('<svg') ||
      head.startsWith('<!doctype html') ||
      head.startsWith('<html') ||
      head.startsWith('<script') ||
      head.includes('<svg') ||
      head.includes('xmlns="http://www.w3.org/2000/svg"')
    );
  };

  const measureExistingTotalBytes = async (storage: IStorageAdapter, targetFullKey: string): Promise<{ count: number; otherBytes: number; exists: boolean }> => {
    const allKeys = typeof storage.listObjects === 'function' ? await storage.listObjects() : [];
    const pluginKeys = allKeys.filter((k) => k.startsWith(prefix));
    let otherBytes = 0;
    let exists = false;
    for (const k of pluginKeys) {
      if (k === targetFullKey) {
        exists = true;
        continue;
      }
      let sz = cachedSizes.get(k);
      if (sz === undefined && typeof storage.get === 'function') {
        const obj = await storage.get(k);
        if (obj) {
          sz =
            typeof obj.contentLength === 'number'
              ? obj.contentLength
              : obj.body instanceof Uint8Array
                ? obj.body.byteLength
                : obj.body instanceof ArrayBuffer
                  ? obj.body.byteLength
                  : 0;
          cachedSizes.set(k, sz);
        } else {
          sz = 0;
        }
      }
      otherBytes += sz ?? 0;
    }
    return { count: pluginKeys.length, otherBytes, exists };
  };

  return {
    async put(key: string, data: ArrayBuffer | Uint8Array | string, contentType = 'application/octet-stream'): Promise<void> {
      const storage = ensureStorage();
      const fullKey = sanitizePluginStorageKey(pluginId, key);

      const dotIdx = fullKey.lastIndexOf('.');
      const ext = dotIdx !== -1 ? fullKey.slice(dotIdx + 1).toLowerCase() : '';
      if (ext && BLOCKED_EXTENSIONS.has(ext)) {
        throw new PluginStorageError(
          pluginId,
          `file extension ".${ext}" is not permitted for plugin storage`,
        );
      }

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

      if (hasDisallowedContentSignature(bytes)) {
        throw new PluginStorageError(
          pluginId,
          'payload contains active HTML/SVG markup and is disallowed in plugin storage',
        );
      }

      if (bytes.byteLength > maxBytes) {
        throw new PluginStorageError(
          pluginId,
          `payload exceeds maximum size of ${maxBytes} bytes`,
        );
      }

      const usage = await measureExistingTotalBytes(storage, fullKey);
      if (!usage.exists && usage.count + 1 > maxObjects) {
        throw new PluginStorageError(
          pluginId,
          `plugin storage object quota (${maxObjects}) exceeded`,
        );
      }
      if (usage.otherBytes + bytes.byteLength > maxTotalBytes) {
        throw new PluginStorageError(
          pluginId,
          `plugin storage cumulative quota (${maxTotalBytes} bytes) exceeded`,
        );
      }

      await storage.put(fullKey, bytes, normalizedType);
      cachedSizes.set(fullKey, bytes.byteLength);
    },

    async get(key: string): Promise<PluginStorageObject | null> {
      const storage = ensureStorage();
      const fullKey = sanitizePluginStorageKey(pluginId, key);
      return storage.get(fullKey);
    },

    async delete(key: string): Promise<void> {
      const storage = ensureStorage();
      const fullKey = sanitizePluginStorageKey(pluginId, key);
      cachedSizes.delete(fullKey);
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

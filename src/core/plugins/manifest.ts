import {
  BURROW_SDK_VERSION,
  type Permission,
  type PluginDialect,
  type PluginManifest,
} from '@burrow/sdk';

export const PLUGIN_ID_RE = /^[a-z][a-z0-9-]{0,30}$/;
const SEMVER_RE = /^v?(\d+)\.(\d+)\.(\d+)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;
const CONFIG_KEY_RE = /^[A-Z][A-Z0-9_]{0,63}$/;
const VALID_DIALECTS = new Set<PluginDialect>(['sqlite', 'postgres']);

export const VALID_PLUGIN_PERMISSIONS: ReadonlySet<Permission> = new Set<Permission>([
  'db:own',
  'routes:api',
  'routes:public',
  'events:read',
  'events:before',
  'policy:override',
  'auth:override',
  'storage:override',
  'storage:own',
  'mailer:override',
  'mentions:register',
  'cards:register',
  'ui:register',
]);

export const ALLOWLISTABLE_CORE_TABLES: ReadonlySet<string> = new Set<string>([
  'workspaces',
  'projects',
  'project_files',
  'members',
  'invites',
  'boards',
  'board_columns',
  'cards',
  'notepads',
  'tags',
  'card_tags',
]);

export class PluginManifestError extends Error {
  constructor(
    public readonly pluginId: string,
    message: string,
  ) {
    super(`Plugin "${pluginId}" manifest error: ${message}`);
    this.name = 'PluginManifestError';
  }
}

export function pluginTablePrefix(pluginId: string): string {
  return `plugin_${pluginId.replace(/-/g, '_')}_`;
}

function parseSemverTuple(version: string): [number, number, number] | null {
  const match = SEMVER_RE.exec(version.trim());
  if (!match) return null;
  return [
    Number.parseInt(match[1]!, 10),
    Number.parseInt(match[2]!, 10),
    Number.parseInt(match[3]!, 10),
  ];
}

function compareSemver(a: [number, number, number], b: [number, number, number]): number {
  if (a[0] !== b[0]) return a[0] - b[0];
  if (a[1] !== b[1]) return a[1] - b[1];
  return a[2] - b[2];
}

export function satisfiesSdkRange(hostVersion: string, range: string): boolean {
  const host = parseSemverTuple(hostVersion);
  if (!host) return false;
  const trimmed = range.trim();
  if (!trimmed) return false;
  if (trimmed === '*' || trimmed === 'x') return true;

  if (trimmed.startsWith('^')) {
    const base = parseSemverTuple(trimmed.slice(1));
    if (!base) return false;
    if (compareSemver(host, base) < 0) return false;
    if (base[0] > 0) return host[0] === base[0];
    if (base[1] > 0) return host[0] === 0 && host[1] === base[1];
    return host[0] === 0 && host[1] === 0 && host[2] === base[2];
  }

  if (trimmed.startsWith('~')) {
    const base = parseSemverTuple(trimmed.slice(1));
    if (!base) return false;
    return compareSemver(host, base) >= 0 && host[0] === base[0] && host[1] === base[1];
  }

  if (trimmed.startsWith('>=')) {
    const base = parseSemverTuple(trimmed.slice(2));
    return base ? compareSemver(host, base) >= 0 : false;
  }

  if (/^\d+\.(\d+|x)\.(x|\*)$/i.test(trimmed)) {
    const [maj, min] = trimmed.split('.');
    if (Number.parseInt(maj!, 10) !== host[0]) return false;
    if (min !== 'x' && min !== '*' && Number.parseInt(min!, 10) !== host[1]) return false;
    return true;
  }

  const exact = parseSemverTuple(trimmed);
  return exact ? compareSemver(host, exact) === 0 : false;
}

function isValidNetworkHostEntry(entry: string): boolean {
  const trimmed = entry.trim().toLowerCase();
  if (!trimmed || trimmed.includes('*') || trimmed.includes('/') || trimmed.includes(':')) {
    return false;
  }
  if (
    trimmed === 'localhost' ||
    trimmed.endsWith('.localhost') ||
    trimmed.endsWith('.local') ||
    trimmed.endsWith('.internal') ||
    /^\d+\.\d+\.\d+\.\d+$/.test(trimmed)
  ) {
    return false;
  }
  return /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+$/.test(trimmed);
}

const MAX_MANIFEST_NAME_CHARS = 120;
const MAX_MANIFEST_DESC_CHARS = 2_000;
const MAX_MANIFEST_SERIALIZED_BYTES = 32_768;
const MAX_MANIFEST_ARRAY_ITEMS = 64;

export function validatePluginManifest(
  manifest: PluginManifest,
  hostSdkVersion = BURROW_SDK_VERSION,
): void {
  const rawId = typeof manifest?.id === 'string' ? manifest.id : '(unknown)';
  if (!manifest || typeof manifest !== 'object') {
    throw new PluginManifestError(rawId, 'manifest must be an object');
  }
  let serializedBytes: number;
  try {
    serializedBytes = JSON.stringify(manifest).length;
  } catch {
    throw new PluginManifestError(rawId, 'manifest must be JSON-serializable');
  }
  if (serializedBytes > MAX_MANIFEST_SERIALIZED_BYTES) {
    throw new PluginManifestError(
      rawId,
      `manifest exceeds maximum serialized size (${MAX_MANIFEST_SERIALIZED_BYTES} bytes)`,
    );
  }
  if (manifest.name !== undefined && (typeof manifest.name !== 'string' || manifest.name.length > MAX_MANIFEST_NAME_CHARS)) {
    throw new PluginManifestError(
      rawId,
      `manifest.name must be a string <= ${MAX_MANIFEST_NAME_CHARS} characters`,
    );
  }
  if (
    manifest.description !== undefined &&
    (typeof manifest.description !== 'string' || manifest.description.length > MAX_MANIFEST_DESC_CHARS)
  ) {
    throw new PluginManifestError(
      rawId,
      `manifest.description must be a string <= ${MAX_MANIFEST_DESC_CHARS} characters`,
    );
  }
  for (const field of ['permissions', 'network', 'configKeys', 'coreTables', 'dependencies', 'dialects'] as const) {
    const val = manifest[field];
    if (Array.isArray(val) && val.length > MAX_MANIFEST_ARRAY_ITEMS) {
      throw new PluginManifestError(
        rawId,
        `manifest.${field} exceeds maximum count (${MAX_MANIFEST_ARRAY_ITEMS})`,
      );
    }
  }
  if (typeof manifest.id !== 'string' || !PLUGIN_ID_RE.test(manifest.id)) {
    throw new PluginManifestError(
      rawId,
      `invalid plugin id "${rawId}" (must match ${PLUGIN_ID_RE.source})`,
    );
  }
  if (typeof manifest.version !== 'string' || !parseSemverTuple(manifest.version)) {
    throw new PluginManifestError(
      manifest.id,
      `invalid version "${String(manifest.version)}" (must be SemVer X.Y.Z)`,
    );
  }
  if (
    typeof manifest.sdkVersion !== 'string' ||
    !satisfiesSdkRange(hostSdkVersion, manifest.sdkVersion)
  ) {
    throw new PluginManifestError(
      manifest.id,
      `requires SDK "${String(manifest.sdkVersion)}", incompatible with host SDK "${hostSdkVersion}"`,
    );
  }
  if (!Array.isArray(manifest.permissions)) {
    throw new PluginManifestError(manifest.id, 'permissions must be an array');
  }
  for (const perm of manifest.permissions) {
    if (!VALID_PLUGIN_PERMISSIONS.has(perm)) {
      throw new PluginManifestError(
        manifest.id,
        `unknown permission "${String(perm)}"`,
      );
    }
  }
  if (manifest.dialects !== undefined) {
    if (!Array.isArray(manifest.dialects) || manifest.dialects.length === 0) {
      throw new PluginManifestError(manifest.id, 'dialects must be a non-empty array when provided');
    }
    for (const d of manifest.dialects) {
      if (!VALID_DIALECTS.has(d)) {
        throw new PluginManifestError(manifest.id, `unknown dialect "${String(d)}"`);
      }
    }
  }
  if (manifest.dependencies !== undefined) {
    if (!Array.isArray(manifest.dependencies)) {
      throw new PluginManifestError(manifest.id, 'dependencies must be an array');
    }
    for (const dep of manifest.dependencies) {
      if (typeof dep !== 'string' || !PLUGIN_ID_RE.test(dep)) {
        throw new PluginManifestError(manifest.id, `invalid dependency id "${String(dep)}"`);
      }
      if (dep === manifest.id) {
        throw new PluginManifestError(manifest.id, 'plugin cannot depend on itself');
      }
    }
  }
  if (manifest.network !== undefined) {
    if (!Array.isArray(manifest.network)) {
      throw new PluginManifestError(manifest.id, 'network allowlist must be an array');
    }
    for (const host of manifest.network) {
      if (typeof host !== 'string' || !isValidNetworkHostEntry(host)) {
        throw new PluginManifestError(
          manifest.id,
          `invalid network allowlist hostname "${String(host)}"`,
        );
      }
    }
  }
  if (manifest.configKeys !== undefined) {
    if (!Array.isArray(manifest.configKeys)) {
      throw new PluginManifestError(manifest.id, 'configKeys must be an array');
    }
    for (const key of manifest.configKeys) {
      if (typeof key !== 'string' || !CONFIG_KEY_RE.test(key)) {
        throw new PluginManifestError(manifest.id, `invalid configKey "${String(key)}"`);
      }
    }
  }
  if (manifest.coreTables !== undefined) {
    if (!Array.isArray(manifest.coreTables)) {
      throw new PluginManifestError(manifest.id, 'coreTables must be an array');
    }
    for (const table of manifest.coreTables) {
      if (typeof table !== 'string' || !ALLOWLISTABLE_CORE_TABLES.has(table)) {
        throw new PluginManifestError(
          manifest.id,
          `table "${String(table)}" is not in the allowlistable core tables set`,
        );
      }
    }
  }
}

export function assertPluginDialectSupported(
  manifest: PluginManifest,
  activeDialect: PluginDialect,
): void {
  if (manifest.dialects && !manifest.dialects.includes(activeDialect)) {
    throw new PluginManifestError(
      manifest.id,
      `does not support active dialect "${activeDialect}" (supported database dialects: ${manifest.dialects.join(', ')})`,
    );
  }
}

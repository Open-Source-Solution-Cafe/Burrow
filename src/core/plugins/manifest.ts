import {
  BURROW_SDK_VERSION,
  type Permission,
  type PluginManifest,
} from '@burrow/sdk';

export const PLUGIN_ID_RE = /^[a-z][a-z0-9-]{0,30}$/;
const SEMVER_RE = /^v?(\d+)\.(\d+)\.(\d+)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;

export const VALID_PLUGIN_PERMISSIONS: ReadonlySet<Permission> = new Set<Permission>([
  'db:own',
  'routes:api',
  'events:read',
  'events:before',
  'policy:override',
  'auth:override',
  'storage:override',
  'mailer:override',
  'mentions:register',
  'cards:register',
  'ui:register',
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

export function validatePluginManifest(
  manifest: PluginManifest,
  hostSdkVersion = BURROW_SDK_VERSION,
): void {
  const rawId = typeof manifest?.id === 'string' ? manifest.id : '(unknown)';
  if (!manifest || typeof manifest !== 'object') {
    throw new PluginManifestError(rawId, 'manifest must be an object');
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
}

export type FeatureFlagKey =
  | 'workspaceExport'
  | 'notionImport'
  | 'publicSharing'
  | 'instanceMigration';

export type FeatureFlagMap = Record<FeatureFlagKey, boolean>;

export interface FeatureFlagDefinition {
  key: FeatureFlagKey;
  label: string;
  description: string;
  defaultValue: boolean;
  category: 'portability' | 'sharing' | 'migration';
}

/**
 * Central registry for all major gated features.
 * Every new major feature defaults to `false` (dormant) until explicitly enabled
 * in Workspace Settings or via instance environment configuration.
 */
export const FEATURE_FLAG_DEFINITIONS: readonly FeatureFlagDefinition[] = [
  {
    key: 'workspaceExport',
    label: 'Workspace Export & Lossless Backup',
    description:
      'Enable one-click full workspace ZIP exports (Markdown, Kanban CSV, media, and lossless BlockNote JSON) plus backup restore.',
    defaultValue: false,
    category: 'portability',
  },
  {
    key: 'notionImport',
    label: 'Notion Markdown & CSV Importer',
    description:
      'Enable importing Notion Markdown + CSV export ZIP archives into projects as hierarchical notepads and Kanban boards.',
    defaultValue: false,
    category: 'portability',
  },
  {
    key: 'publicSharing',
    label: 'Public Read-Only Share Links',
    description:
      'Allow editors and owners to toggle opt-in read-only public web links (/s/:token) on individual notepads and boards.',
    defaultValue: false,
    category: 'sharing',
  },
  {
    key: 'instanceMigration',
    label: 'Instance Data Migration',
    description:
      'Enable portable workspace bundle migration between Burrow instances. Must be turned on before porting workspace data.',
    defaultValue: false,
    category: 'migration',
  },
] as const;

export const DEFAULT_FEATURE_FLAGS: FeatureFlagMap = {
  workspaceExport: false,
  notionImport: false,
  publicSharing: false,
  instanceMigration: false,
};

const VALID_KEYS = new Set<string>(FEATURE_FLAG_DEFINITIONS.map((d) => d.key));

export function isFeatureFlagKey(value: string): value is FeatureFlagKey {
  return VALID_KEYS.has(value);
}

export function parseFeatureFlagsJson(raw: string | null | undefined): Partial<FeatureFlagMap> {
  if (!raw || typeof raw !== 'string') return {};
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    const out: Partial<FeatureFlagMap> = {};
    for (const [k, v] of Object.entries(parsed)) {
      if (isFeatureFlagKey(k) && typeof v === 'boolean') {
        out[k] = v;
      }
    }
    return out;
  } catch {
    return {};
  }
}

export function parseFeatureFlagsEnv(raw: string | null | undefined): Partial<FeatureFlagMap> {
  if (!raw || typeof raw !== 'string') return {};
  const trimmed = raw.trim();
  if (!trimmed) return {};
  if (trimmed.startsWith('{')) {
    return parseFeatureFlagsJson(trimmed);
  }
  const out: Partial<FeatureFlagMap> = {};
  for (const part of trimmed.split(',')) {
    const [rawKey, rawVal] = part.split('=').map((s) => s.trim());
    if (!rawKey || !isFeatureFlagKey(rawKey)) continue;
    if (rawVal === undefined || rawVal === '' || rawVal === 'true' || rawVal === '1') {
      out[rawKey] = true;
    } else if (rawVal === 'false' || rawVal === '0') {
      out[rawKey] = false;
    }
  }
  return out;
}

export function resolveFeatureFlags(args: {
  envFlags?: Partial<FeatureFlagMap>;
  policyFlags?: Partial<FeatureFlagMap>;
  workspaceFlags?: Partial<FeatureFlagMap>;
}): FeatureFlagMap {
  return {
    ...DEFAULT_FEATURE_FLAGS,
    ...args.envFlags,
    ...args.workspaceFlags,
    ...args.policyFlags,
  };
}

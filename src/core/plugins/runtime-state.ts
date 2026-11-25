import { describePluginCapabilities, formatPluginConsentSummary, type PluginManifest } from '@burrow/sdk';

export interface RegisteredPluginRecord {
  manifest: PluginManifest;
  enabled: boolean;
  killSwitched: boolean;
  firstPartyCore: boolean;
  instanceManaged: boolean;
}

export interface PluginAdminView {
  id: string;
  name: string;
  version: string;
  description: string | null;
  permissions: readonly string[];
  network: readonly string[];
  configKeys: readonly string[];
  coreTables: readonly string[];
  dialects: readonly string[];
  dependencies: readonly string[];
  enabled: boolean;
  killSwitched: boolean;
  instanceManaged: boolean;
  capabilities: string[];
  consentSummary: string;
}

export interface ParsedPluginsDisabled {
  ids: Set<string>;
  wildcardAll: boolean;
}

export function parseDisabledPluginsEnv(raw: unknown): ParsedPluginsDisabled {
  const ids = new Set<string>();
  let wildcardAll = false;
  if (typeof raw !== 'string' || !raw.trim()) {
    return { ids, wildcardAll };
  }
  for (const token of raw.split(',')) {
    const trimmed = token.trim();
    if (!trimmed) continue;
    if (trimmed === '*') {
      wildcardAll = true;
    } else {
      ids.add(trimmed);
    }
  }
  return { ids, wildcardAll };
}

export interface PluginRuntimeRegistryOptions {
  /** Canonical kill-switch env value (`PLUGINS_DISABLED`: comma-separated IDs or `*`). */
  pluginsDisabledEnv?: unknown;
  /** Deprecated alias (`DISABLED_PLUGINS`). Logs a warning when supplied without `PLUGINS_DISABLED`. */
  disabledPluginsEnv?: unknown;
  instanceManaged?: boolean;
}

/**
 * Runtime registry tracking loaded plugins, kill-switched IDs (`PLUGINS_DISABLED` / deprecated
 * `DISABLED_PLUGINS`), and operator/admin enable-disable toggles without requiring a redeploy.
 */
export class PluginRuntimeRegistry {
  private readonly records = new Map<string, RegisteredPluginRecord>();
  private readonly envDisabled: Set<string>;
  private readonly wildcardDisabled: boolean;
  private readonly instanceManaged: boolean;

  constructor(optionsOrDisabled: PluginRuntimeRegistryOptions | string = {}) {
    const opts: PluginRuntimeRegistryOptions =
      typeof optionsOrDisabled === 'string'
        ? { pluginsDisabledEnv: optionsOrDisabled }
        : optionsOrDisabled;

    const canonicalRaw = opts.pluginsDisabledEnv;
    const deprecatedRaw = opts.disabledPluginsEnv;

    if (
      typeof deprecatedRaw === 'string' &&
      deprecatedRaw.trim().length > 0 &&
      (typeof canonicalRaw !== 'string' || !canonicalRaw.trim())
    ) {
      console.warn('[plugins] DISABLED_PLUGINS is deprecated; use PLUGINS_DISABLED instead.');
    }

    const parsedCanonical = parseDisabledPluginsEnv(canonicalRaw);
    const parsedDeprecated = parseDisabledPluginsEnv(deprecatedRaw);
    this.envDisabled = new Set([...parsedCanonical.ids, ...parsedDeprecated.ids]);
    this.wildcardDisabled = parsedCanonical.wildcardAll || parsedDeprecated.wildcardAll;
    this.instanceManaged = Boolean(opts.instanceManaged);
  }

  private isKillSwitchedByEnv(pluginId: string): boolean {
    return this.wildcardDisabled || this.envDisabled.has(pluginId);
  }

  isKillSwitched(pluginId: string): boolean {
    return this.isKillSwitchedByEnv(pluginId);
  }

  register(
    manifest: PluginManifest,
    opts: { firstPartyCore?: boolean; consented?: boolean } = {},
  ): RegisteredPluginRecord {
    const killSwitched = this.isKillSwitchedByEnv(manifest.id);
    const firstPartyCore = Boolean(opts.firstPartyCore);
    const consented = Boolean(opts.consented);
    const record: RegisteredPluginRecord = {
      manifest,
      enabled: !killSwitched && (firstPartyCore || consented),
      killSwitched,
      firstPartyCore,
      instanceManaged: this.instanceManaged || firstPartyCore,
    };
    this.records.set(manifest.id, record);
    return record;
  }

  isEnabled(pluginId: string): boolean {
    if (this.isKillSwitchedByEnv(pluginId)) return false;
    const rec = this.records.get(pluginId);
    return rec ? rec.enabled && !rec.killSwitched : true;
  }

  setEnabled(pluginId: string, enabled: boolean): RegisteredPluginRecord | null {
    const rec = this.records.get(pluginId);
    if (!rec) return null;
    if (rec.killSwitched && enabled) {
      throw new Error(`Plugin "${pluginId}" is kill-switched by PLUGINS_DISABLED environment setting`);
    }
    rec.enabled = enabled;
    return rec;
  }

  get(pluginId: string): RegisteredPluginRecord | undefined {
    return this.records.get(pluginId);
  }

  listViews(): PluginAdminView[] {
    return [...this.records.values()].map((rec) => ({
      id: rec.manifest.id,
      name: rec.manifest.name ?? rec.manifest.id,
      version: rec.manifest.version,
      description: rec.manifest.description ?? null,
      permissions: rec.manifest.permissions,
      network: rec.manifest.network ?? [],
      configKeys: rec.manifest.configKeys ?? [],
      coreTables: rec.manifest.coreTables ?? [],
      dialects: rec.manifest.dialects ?? ['sqlite', 'postgres'],
      dependencies: rec.manifest.dependencies ?? [],
      enabled: rec.enabled && !rec.killSwitched,
      killSwitched: rec.killSwitched,
      instanceManaged: rec.instanceManaged,
      capabilities: describePluginCapabilities(rec.manifest),
      consentSummary: formatPluginConsentSummary(rec.manifest),
    }));
  }
}

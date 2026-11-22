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
  dialects: readonly string[];
  dependencies: readonly string[];
  enabled: boolean;
  killSwitched: boolean;
  instanceManaged: boolean;
  capabilities: string[];
  consentSummary: string;
}

export function parseDisabledPluginsEnv(raw: unknown): Set<string> {
  if (typeof raw !== 'string' || !raw.trim()) return new Set();
  return new Set(
    raw
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
  );
}

/**
 * Runtime registry tracking loaded plugins, kill-switched IDs (`DISABLED_PLUGINS`),
 * and operator/admin enable-disable toggles without requiring a redeploy.
 */
export class PluginRuntimeRegistry {
  private readonly records = new Map<string, RegisteredPluginRecord>();
  private readonly envDisabled: Set<string>;
  private readonly instanceManaged: boolean;

  constructor(options: { disabledPluginsEnv?: unknown; instanceManaged?: boolean } = {}) {
    this.envDisabled = parseDisabledPluginsEnv(options.disabledPluginsEnv);
    this.instanceManaged = Boolean(options.instanceManaged);
  }

  register(manifest: PluginManifest, opts: { firstPartyCore?: boolean } = {}): RegisteredPluginRecord {
    const killSwitched = this.envDisabled.has(manifest.id);
    const record: RegisteredPluginRecord = {
      manifest,
      enabled: !killSwitched,
      killSwitched,
      firstPartyCore: Boolean(opts.firstPartyCore),
      instanceManaged: this.instanceManaged || Boolean(opts.firstPartyCore),
    };
    this.records.set(manifest.id, record);
    return record;
  }

  isEnabled(pluginId: string): boolean {
    if (this.envDisabled.has(pluginId)) return false;
    const rec = this.records.get(pluginId);
    return rec ? rec.enabled && !rec.killSwitched : true;
  }

  setEnabled(pluginId: string, enabled: boolean): RegisteredPluginRecord | null {
    const rec = this.records.get(pluginId);
    if (!rec) return null;
    if (rec.killSwitched && enabled) {
      throw new Error(`Plugin "${pluginId}" is kill-switched by DISABLED_PLUGINS environment setting`);
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

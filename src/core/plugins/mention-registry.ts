import type { MentionCandidate, MentionPreview, MentionScope, MentionSourceAdapter } from '@burrow/sdk';

export const PLUGIN_MENTION_KIND_RE = /^plugin:([a-z][a-z0-9-]{0,30}):([a-z][a-z0-9-]{0,30})$/;
const MENTION_TIMEOUT_MS = 2_500;

interface RegisteredMentionSource {
  pluginId: string;
  adapter: MentionSourceAdapter;
  isEnabled?: () => boolean;
}

async function withTimeout<T>(fn: () => Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      fn(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`Mention source timed out after ${ms}ms`)), ms);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export class MentionSourceRegistry {
  private readonly sources = new Map<string, RegisteredMentionSource>();

  register(
    pluginId: string,
    source: MentionSourceAdapter,
    options: { isEnabled?: () => boolean } = {},
  ): void {
    const match = PLUGIN_MENTION_KIND_RE.exec(source.kind);
    if (!match || match[1] !== pluginId) {
      throw new Error(
        `Plugin "${pluginId}" mention source kind "${source.kind}" must match "plugin:${pluginId}:<type>"`,
      );
    }
    if (this.sources.has(source.kind)) {
      throw new Error(`Mention source "${source.kind}" is already registered`);
    }
    this.sources.set(source.kind, {
      pluginId,
      adapter: source,
      isEnabled: options.isEnabled,
    });
  }

  has(kind: string): boolean {
    const entry = this.sources.get(kind);
    if (!entry) return false;
    return entry.isEnabled ? entry.isEnabled() : true;
  }

  listKinds(): string[] {
    return [...this.sources.entries()]
      .filter(([, entry]) => !entry.isEnabled || entry.isEnabled())
      .map(([kind]) => kind);
  }

  async suggest(kind: string, query: string, scope: MentionScope): Promise<MentionCandidate[]> {
    const entry = this.sources.get(kind);
    if (!entry || (entry.isEnabled && !entry.isEnabled())) return [];
    const items = await withTimeout(() => entry.adapter.suggest(query, scope), MENTION_TIMEOUT_MS);
    return items.map((item) => ({ ...item, kind: entry.adapter.kind }));
  }

  async suggestAll(
    query: string,
    scope: MentionScope,
  ): Promise<Array<MentionCandidate & { kind: string; group: string }>> {
    const active = [...this.sources.values()].filter((entry) => !entry.isEnabled || entry.isEnabled());
    const settled = await Promise.allSettled(
      active.map(async (entry) => {
        const items = await withTimeout(
          () => entry.adapter.suggest(query, scope),
          MENTION_TIMEOUT_MS,
        );
        return items.map((item) => ({
          ...item,
          kind: entry.adapter.kind,
          group: entry.adapter.label,
        }));
      }),
    );

    const results: Array<MentionCandidate & { kind: string; group: string }> = [];
    settled.forEach((res, idx) => {
      if (res.status === 'fulfilled') {
        results.push(...res.value);
      } else {
        const entry = active[idx]!;
        console.error(`[plugins:mentions:${entry.pluginId}] suggest failed for ${entry.adapter.kind}:`, res.reason);
      }
    });
    return results;
  }

  async resolve(
    kind: string,
    id: string,
    scope: { workspaceId: string; projectId: string; userId?: string },
  ): Promise<MentionPreview | null> {
    const entry = this.sources.get(kind);
    if (!entry || (entry.isEnabled && !entry.isEnabled()) || !entry.adapter.resolve) return null;
    return withTimeout(() => entry.adapter.resolve!(id, scope), MENTION_TIMEOUT_MS);
  }
}

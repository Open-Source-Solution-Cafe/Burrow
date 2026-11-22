import type { MentionCandidate, MentionPreview, MentionScope, MentionSourceAdapter } from '@burrow/sdk';

export const PLUGIN_MENTION_KIND_RE = /^plugin:([a-z][a-z0-9-]{0,30}):([a-z][a-z0-9-]{0,30})$/;

export class MentionSourceRegistry {
  private readonly sources = new Map<string, MentionSourceAdapter>();

  register(pluginId: string, source: MentionSourceAdapter): void {
    const match = PLUGIN_MENTION_KIND_RE.exec(source.kind);
    if (!match || match[1] !== pluginId) {
      throw new Error(
        `Plugin "${pluginId}" mention source kind "${source.kind}" must match "plugin:${pluginId}:<type>"`,
      );
    }
    if (this.sources.has(source.kind)) {
      throw new Error(`Mention source "${source.kind}" is already registered`);
    }
    this.sources.set(source.kind, source);
  }

  has(kind: string): boolean {
    return this.sources.has(kind);
  }

  listKinds(): string[] {
    return [...this.sources.keys()];
  }

  async suggest(kind: string, query: string, scope: MentionScope): Promise<MentionCandidate[]> {
    const source = this.sources.get(kind);
    if (!source) return [];
    const items = await source.suggest(query, scope);
    return items.map((item) => ({ ...item, kind: source.kind }));
  }

  async suggestAll(
    query: string,
    scope: MentionScope,
  ): Promise<Array<MentionCandidate & { kind: string; group: string }>> {
    const results: Array<MentionCandidate & { kind: string; group: string }> = [];
    for (const source of this.sources.values()) {
      try {
        const items = await source.suggest(query, scope);
        for (const item of items) {
          results.push({ ...item, kind: source.kind, group: source.label });
        }
      } catch (err) {
        console.error(`[plugins:mentions] suggest failed for ${source.kind}:`, err);
      }
    }
    return results;
  }

  async resolve(
    kind: string,
    id: string,
    scope: { workspaceId: string; projectId: string; userId?: string },
  ): Promise<MentionPreview | null> {
    const source = this.sources.get(kind);
    if (!source?.resolve) return null;
    return source.resolve(id, scope);
  }
}

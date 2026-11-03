import type { ExtractedLink as StoredLink } from '../../shared/extract';
const linkKey = (l: { targetType: string; targetId: string }) => `${l.targetType}:${l.targetId}`;

/** Resolve each target kind in bulk, preserving first-reference order without duplicates. */
export async function resolveReferenceTargets(
  links: StoredLink[],
  lookup: (type: StoredLink['targetType'], ids: string[]) => Promise<string[]>,
): Promise<StoredLink[]> {
  const unique = [...new Map(links.map((link) => [linkKey(link), link])).values()];
  const groups = new Map<StoredLink['targetType'], string[]>();
  for (const { targetType, targetId } of unique) {
    const ids = groups.get(targetType) ?? [];
    ids.push(targetId);
    groups.set(targetType, ids);
  }
  const valid = new Set<string>();
  await Promise.all(
    [...groups].map(async ([type, ids]) => {
      for (const id of await lookup(type, ids))
        valid.add(linkKey({ targetType: type, targetId: id }));
    }),
  );
  return unique.filter((link) => valid.has(linkKey(link)));
}

/** Diff previous vs new references: added drives notifications, removed is a silent delete. */
export function diffLinks(
  previous: StoredLink[],
  next: StoredLink[],
): { added: StoredLink[]; removed: StoredLink[] } {
  const prevMap = new Map(previous.map((l) => [linkKey(l), l]));
  const nextMap = new Map(next.map((l) => [linkKey(l), l]));
  const added = [...nextMap.entries()].filter(([k]) => !prevMap.has(k)).map(([, v]) => v);
  const removed = [...prevMap.entries()].filter(([k]) => !nextMap.has(k)).map(([, v]) => v);
  return { added, removed };
}

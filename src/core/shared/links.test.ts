import { describe, expect, it, vi } from 'vitest';
import { diffLinks, resolveReferenceTargets } from './links';
import type { ExtractedLink } from '../../shared/extract';

const ref = (targetType: ExtractedLink['targetType'], targetId: string): ExtractedLink => ({
  targetType,
  targetId,
});

describe('Reference grouping and diffing', () => {
  it('resolves unique groups and preserves first-reference order across result order', async () => {
    const lookup = vi.fn(async (type: ExtractedLink['targetType'], ids: string[]) =>
      type === 'board' ? [] : [...ids].reverse(),
    );
    const links = [
      ref('notepad', 'same'),
      ref('user', 'same'),
      ref('notepad', 'other'),
      ref('board', 'same'),
    ];
    expect(await resolveReferenceTargets([...links, links[0]!], lookup)).toEqual(links.slice(0, 3));
    expect(lookup.mock.calls).toEqual([
      ['notepad', ['same', 'other']],
      ['user', ['same']],
      ['board', ['same']],
    ]);
  });
  it('performs no lookups for empty references', async () => {
    const lookup = vi.fn(async () => []);
    expect(await resolveReferenceTargets([], lookup)).toEqual([]);
    expect(lookup).not.toHaveBeenCalled();
  });
  it('propagates failed validation rather than accepting unvalidated references', async () => {
    await expect(
      resolveReferenceTargets([ref('notepad', 'id')], async () => {
        throw new Error('lookup failed');
      }),
    ).rejects.toThrow('lookup failed');
  });
  it('diffs unique reference identities without conflating target kinds', () => {
    expect(diffLinks([ref('user', 'same'), ref('user', 'same')], [ref('notepad', 'same')])).toEqual(
      { added: [ref('notepad', 'same')], removed: [ref('user', 'same')] },
    );
    expect(diffLinks([], [])).toEqual({ added: [], removed: [] });
  });
});

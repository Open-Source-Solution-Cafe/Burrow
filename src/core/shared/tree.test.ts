import { describe, expect, it, vi } from 'vitest';
import {
  getDepth,
  getDescendantIds,
  getSubtreeHeight,
  wouldCauseCycle,
  type TreeNode,
} from './tree';

function lookups(nodes: TreeNode[]) {
  return {
    children: vi.fn(async (ids: string[]) =>
      nodes.filter((node) => node.parentId && ids.includes(node.parentId)),
    ),
    parent: vi.fn(async (id: string) => nodes.find((node) => node.id === id) ?? null),
  };
}

describe('Canonical tree traversal', () => {
  it('treats an empty lookup as an implicit leaf/root', async () => {
    const { children, parent } = lookups([]);
    expect(await getDescendantIds(children, 'missing')).toEqual([]);
    expect(await getSubtreeHeight(children, 'missing')).toBe(1);
    expect(await getDepth(parent, 'missing')).toBe(1);
  });

  it('visits a branching tree breadth-first and computes depth/height', async () => {
    const { children, parent } = lookups([
      { id: 'root', parentId: null },
      { id: 'a', parentId: 'root' },
      { id: 'b', parentId: 'root' },
      { id: 'c', parentId: 'a' },
      { id: 'd', parentId: 'c' },
    ]);
    expect(await getDescendantIds(children, 'root')).toEqual(['a', 'b', 'c', 'd']);
    expect(children.mock.calls).toEqual([[['root']], [['a', 'b']], [['c']], [['d']]]);
    expect(await getSubtreeHeight(children, 'root')).toBe(4);
    expect(await getDepth(parent, 'd')).toBe(4);
    expect(await getDescendantIds(children, 'b')).toEqual([]);
  });

  it('handles chains deeper than the previous arbitrary twenty-node cutoff', async () => {
    const nodes = Array.from({ length: 60 }, (_, i) => ({
      id: String(i),
      parentId: i ? String(i - 1) : null,
    }));
    const { children, parent } = lookups(nodes);
    expect(await getDepth(parent, '59')).toBe(60);
    expect(await getSubtreeHeight(children, '0')).toBe(60);
    expect(await getDescendantIds(children, '0')).toHaveLength(59);
  });

  it('terminates an ancestor chain at a missing parent', async () => {
    const { parent } = lookups([{ id: 'orphan', parentId: 'missing' }]);
    expect(await getDepth(parent, 'orphan')).toBe(2);
    expect(parent).toHaveBeenCalledTimes(2);
  });

  it.each([
    [{ id: 'root', parentId: 'root' }],
    [
      { id: 'root', parentId: 'child' },
      { id: 'child', parentId: 'root' },
    ],
  ])('rejects corrupt cycles in descendants, height and ancestors', async (...nodes) => {
    const { children, parent } = lookups(nodes);
    await expect(getDescendantIds(children, 'root')).rejects.toThrow('tree_cycle_detected');
    await expect(getSubtreeHeight(children, 'root')).rejects.toThrow('tree_cycle_detected');
    await expect(getDepth(parent, 'root')).rejects.toThrow('tree_cycle_detected');
  });

  it('rejects repeated IDs returned by a malformed lookup', async () => {
    const children = async () => [
      { id: 'child', parentId: 'root' },
      { id: 'child', parentId: 'root' },
    ];
    await expect(getDescendantIds(children, 'root')).rejects.toThrow('tree_cycle_detected');
  });

  it('does not hide lookup failures', async () => {
    const failure = async () => {
      throw new Error('database unavailable');
    };
    await expect(getDescendantIds(failure, 'root')).rejects.toThrow('database unavailable');
    await expect(getDepth(failure, 'root')).rejects.toThrow('database unavailable');
  });

  it('short-circuits root/self moves and checks descendant moves', async () => {
    const descendants = vi.fn(async () => ['child']);
    expect(await wouldCauseCycle(descendants, 'root', null)).toBe(false);
    expect(await wouldCauseCycle(descendants, 'root', 'root')).toBe(true);
    expect(descendants).not.toHaveBeenCalled();
    expect(await wouldCauseCycle(descendants, 'root', 'child')).toBe(true);
    expect(await wouldCauseCycle(descendants, 'root', 'other')).toBe(false);
    expect(descendants).toHaveBeenCalledTimes(2);
  });
});

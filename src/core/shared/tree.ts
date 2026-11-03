export interface TreeNode {
  id: string;
  parentId: string | null;
}

type ChildLookup = (parentIds: string[]) => Promise<TreeNode[]>;

/** One breadth-first traversal; revisiting an ID indicates a corrupt tree. */
async function walkSubtree(getChildren: ChildLookup, rootId: string) {
  const visited = new Set([rootId]);
  let frontier = [rootId];
  let height = 1;
  while (frontier.length) {
    const children = await getChildren(frontier);
    if (!children.length) break;
    frontier = children.map(({ id }) => {
      if (visited.has(id)) throw new Error('tree_cycle_detected');
      visited.add(id);
      return id;
    });
    height++;
  }
  return { visited, height };
}

/** Descendants in lookup/breadth-first order, excluding the implicit root. */
export async function getDescendantIds(
  getChildren: ChildLookup,
  rootId: string,
): Promise<string[]> {
  return [...(await walkSubtree(getChildren, rootId)).visited].slice(1);
}

/** Ancestor depth, with an implicit/missing root at 1; corrupt cycles throw. */
export async function getDepth(
  getParent: (id: string) => Promise<TreeNode | null>,
  nodeId: string,
): Promise<number> {
  const visited = new Set<string>();
  let currentId: string | null = nodeId;
  let depth = 1;
  while (currentId) {
    if (visited.has(currentId)) throw new Error('tree_cycle_detected');
    visited.add(currentId);
    const node = await getParent(currentId);
    if (!node?.parentId) break;
    depth++;
    currentId = node.parentId;
  }
  return depth;
}

/** Height of the implicit root and its descendants; a leaf/missing root has height 1. */
export async function getSubtreeHeight(getChildren: ChildLookup, rootId: string): Promise<number> {
  return (await walkSubtree(getChildren, rootId)).height;
}

/** Whether moving source beneath target would place it inside its own subtree. */
export async function wouldCauseCycle(
  getDescendants: (rootId: string) => Promise<string[]>,
  sourceId: string,
  targetParentId: string | null,
): Promise<boolean> {
  if (!targetParentId) return false;
  return sourceId === targetParentId || (await getDescendants(sourceId)).includes(targetParentId);
}

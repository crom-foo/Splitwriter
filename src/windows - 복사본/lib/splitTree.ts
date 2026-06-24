// src/windows/lib/splitTree.ts
// Split tree model + immutable helpers (path-based updates)
export type BoardType = "text" | "image" | "outliner" | "ai";

export type LeafNode = {
  type: "leaf";
  id: string;
};

export type SplitNode = {
  type: "split";
  dir: "vertical" | "horizontal"; // vertical = left/right, horizontal = top/bottom
  a: Node;
  b: Node;
  ratio: number; // 0..1 (portion of A pane)
};

export type Node = LeafNode | SplitNode;

/** Replace the target leaf with a split node */
export function splitLeaf(
  root: Node,
  targetLeafId: string,
  dir: "vertical" | "horizontal", 
  makeChildren: () => { a: LeafNode; b: LeafNode; ratio?: number }
): Node {
  function walk(n: Node): Node {
    if (n.type === "leaf") {
      if (n.id !== targetLeafId) return n;
      const { a, b, ratio } = makeChildren();
      return { type: "split", dir, a, b, ratio: ratio ?? 0.5 };
    }
    return { ...n, a: walk(n.a), b: walk(n.b) };
  }
  return walk(root);
}

/** Update ratio by path (e.g., "root", "root.a", "root.a.b") */
export function updateRatioByPath(root: Node, path: string, nextRatio: number): Node {
  const segs = path.split(".").filter(Boolean);
  if (segs.length === 0 || segs[0] !== "root") return root;

  function walk(n: Node, idx: number): Node {
    if (idx === segs.length - 1) {
      // Last segment must be a split node
      if (n.type === "split") {
        return { ...n, ratio: clamp(nextRatio, 0, 1) };
      }
      return n;
    }
    if (n.type !== "split") return n;
    const seg = segs[idx + 1];
    if (seg === "a") return { ...n, a: walk(n.a, idx + 1) };
    if (seg === "b") return { ...n, b: walk(n.b, idx + 1) };
    return n;
  }
  return walk(root, 0);
}

function clamp(v: number, a: number, b: number) {
  return Math.max(a, Math.min(b, v));
}

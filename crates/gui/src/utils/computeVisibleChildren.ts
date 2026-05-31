import type { TaskTreeNode } from "../types/ui";
import { isTaskDone } from "./runState";

/**
 * A node is a "done leaf" when it is itself done (per {@link isTaskDone}) and
 * has no children. Done *parents* are never hidden — only terminal leaves
 * participate in hide-done behaviour.
 */
export function isDoneLeaf(node: TaskTreeNode): boolean {
  return node.children.length === 0 && isTaskDone(node.task);
}

/**
 * A real task row.
 */
export interface NodeChild {
  kind: "node";
  node: TaskTreeNode;
}

export type VisibleChild = NodeChild;

export interface VisibleChildrenOptions {
  /** When true, omit done-leaf children entirely. */
  hideCompleted: boolean;
  /**
   * When true a scope filter or search is active, so hide-done is bypassed —
   * the caller wants to see every match.
   */
  filtering: boolean;
}

/**
 * Compute the ordered list of visible children for one expanded parent node.
 *
 * This is the single source of truth shared by both the recursive render
 * (`TaskTreeNode`) and the keyboard-navigation flattener
 * (`flattenVisibleNodes`) so the two can never disagree about which rows are
 * present or in what order.
 *
 * Rules:
 * - While `filtering`, children are returned unchanged.
 * - When `hideCompleted`, done-leaf children are omitted.
 */
export function computeVisibleChildren(
  node: TaskTreeNode,
  { hideCompleted, filtering }: VisibleChildrenOptions
): VisibleChild[] {
  const children = node.children;
  if (filtering) {
    return children.map((child) => ({ kind: "node", node: child }));
  }

  const out: VisibleChild[] = [];
  for (const child of children) {
    if (hideCompleted && isDoneLeaf(child)) continue;
    out.push({ kind: "node", node: child });
  }

  return out;
}

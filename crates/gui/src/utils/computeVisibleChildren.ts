import type { TaskTreeNode } from "../types/ui";
import { isTaskDone } from "./runState";

/**
 * Fold this many done-leaf children under a single parent into one collapsed
 * summary row. Below the threshold the done leaves render inline as usual.
 */
export const COLLAPSE_THRESHOLD = 3;

/**
 * A node is a "done leaf" when it is itself done (per {@link isTaskDone}) and
 * has no children. Done *parents* are never hidden or folded — only terminal
 * leaves participate in hide-done / done-summary behaviour.
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

/**
 * A collapsed summary standing in for `count` folded done leaves under
 * `parentId`. Summary rows are not selectable and carry no task.
 */
export interface SummaryChild {
  kind: "summary";
  parentId: string;
  count: number;
}

export type VisibleChild = NodeChild | SummaryChild;

export interface VisibleChildrenOptions {
  /** When true, omit done-leaf children entirely. */
  hideCompleted: boolean;
  /**
   * When true a scope filter or search is active, so both hide-done and the
   * done-summary collapse are bypassed — the caller wants to see every match.
   */
  filtering: boolean;
  /** Parent ids whose folded done-leaf summary is currently expanded. */
  summaryExpanded: ReadonlySet<string>;
}

/**
 * Compute the ordered list of visible children for one expanded parent node.
 *
 * This is the single source of truth shared by both the recursive render
 * (`TaskTreeNode`) and the keyboard-navigation flattener
 * (`flattenVisibleNodes`) so the two can never disagree about which rows are
 * present or in what order.
 *
 * Rules (matching the Hearth prototype `computeItems`):
 * - While `filtering`, children are returned unchanged.
 * - When `hideCompleted`, done-leaf children are omitted.
 * - Otherwise, when a parent has at least {@link COLLAPSE_THRESHOLD} done-leaf
 *   children, those leaves are folded into a single summary row. The summary's
 *   leaves are re-emitted inline (after the summary row) only when the parent
 *   id appears in `summaryExpanded`.
 */
export function computeVisibleChildren(
  node: TaskTreeNode,
  { hideCompleted, filtering, summaryExpanded }: VisibleChildrenOptions
): VisibleChild[] {
  const children = node.children;
  if (filtering) {
    return children.map((child) => ({ kind: "node", node: child }));
  }

  const doneLeaves = children.filter(isDoneLeaf);
  const collapse = !hideCompleted && doneLeaves.length >= COLLAPSE_THRESHOLD;

  const out: VisibleChild[] = [];
  for (const child of children) {
    const leaf = isDoneLeaf(child);
    if (hideCompleted && leaf) continue;
    if (collapse && leaf) continue;
    out.push({ kind: "node", node: child });
  }

  if (collapse) {
    out.push({
      kind: "summary",
      parentId: node.task.id,
      count: doneLeaves.length,
    });
    if (summaryExpanded.has(node.task.id)) {
      for (const leaf of doneLeaves) {
        out.push({ kind: "node", node: leaf });
      }
    }
  }

  return out;
}

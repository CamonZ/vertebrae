import type { TaskTreeNode } from "../types/ui";

/**
 * Fold this many completed sibling children under a single parent into one
 * collapsed summary row. Below the threshold the completed children render
 * inline as usual.
 */
export const COLLAPSE_THRESHOLD = 3;

/**
 * A node is "fully complete" when it has a completion timestamp and — for
 * parents — every descendant is fully complete too. Both childless completed
 * leaves and completed parents whose entire subtree is done participate in the
 * hide-done / done-summary collapse. A completed parent with even one open
 * descendant stays expanded so the unfinished work remains visible.
 */
export function isFullyComplete(node: TaskTreeNode): boolean {
  return (
    Boolean(node.task.completed_at) && node.children.every(isFullyComplete)
  );
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
 * Stable `summaryExpanded` key for the root-level done summary. Real tasks use
 * UUID ids, so this sentinel can never collide with a parent id.
 */
export const ROOT_SUMMARY_KEY = "__root__";

/**
 * Core collapse over one set of siblings, keyed by `summaryKey` for the folded
 * summary row. Shared by {@link computeVisibleChildren} (a parent's children,
 * keyed by the parent id) and {@link computeVisibleRoots} (the top-level
 * forest, keyed by {@link ROOT_SUMMARY_KEY}).
 *
 * Rules (matching the Hearth prototype `computeItems`):
 * - While `filtering`, siblings are returned unchanged.
 * - When `hideCompleted`, fully-complete siblings are omitted.
 * - Otherwise, when at least {@link COLLAPSE_THRESHOLD} siblings are fully
 *   complete, those are folded into a single summary row. The folded siblings
 *   are re-emitted inline (after the summary row) only when `summaryKey`
 *   appears in `summaryExpanded`.
 */
function collapseSiblings(
  siblings: TaskTreeNode[],
  summaryKey: string,
  { hideCompleted, filtering, summaryExpanded }: VisibleChildrenOptions
): VisibleChild[] {
  if (filtering) {
    return siblings.map((child) => ({ kind: "node", node: child }));
  }

  const completed = siblings.filter(isFullyComplete);
  const collapse = !hideCompleted && completed.length >= COLLAPSE_THRESHOLD;

  const out: VisibleChild[] = [];
  for (const child of siblings) {
    const done = isFullyComplete(child);
    if (hideCompleted && done) continue;
    if (collapse && done) continue;
    out.push({ kind: "node", node: child });
  }

  if (collapse) {
    out.push({
      kind: "summary",
      parentId: summaryKey,
      count: completed.length,
    });
    if (summaryExpanded.has(summaryKey)) {
      for (const child of completed) {
        out.push({ kind: "node", node: child });
      }
    }
  }

  return out;
}

/**
 * Compute the ordered list of visible children for one expanded parent node.
 *
 * This is the single source of truth shared by both the recursive render
 * (`TaskTreeNode`) and the keyboard-navigation flattener
 * (`flattenVisibleNodes`) so the two can never disagree about which rows are
 * present or in what order.
 */
export function computeVisibleChildren(
  node: TaskTreeNode,
  options: VisibleChildrenOptions
): VisibleChild[] {
  return collapseSiblings(node.children, node.task.id, options);
}

/**
 * Same collapse, applied to the top-level forest. Without this, fully-complete
 * top-level items (including children orphaned to the root because their parent
 * was archived/filtered out of the loaded set) would never fold, since the root
 * forest does not pass through {@link computeVisibleChildren}.
 */
export function computeVisibleRoots(
  roots: TaskTreeNode[],
  options: VisibleChildrenOptions
): VisibleChild[] {
  return collapseSiblings(roots, ROOT_SUMMARY_KEY, options);
}

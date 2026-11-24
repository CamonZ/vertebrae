/** The two ends of a workflow transition: all column ordering needs. */
export interface ColumnTransition {
  from_workflow_id: string;
  to_workflow_id: string;
}

/**
 * Topologically sort kanban columns based on workflow transitions.
 *
 * Builds a DAG of column-level edges from workflow transitions,
 * dropping edges that would create cycles (e.g. rework transitions).
 * Terminal columns (no outgoing edges) are placed last.
 * Kahn's algorithm produces left-to-right order.
 */
export function topologicalColumnSort(
  allColumns: Set<string>,
  transitions: ReadonlyArray<ColumnTransition>,
  workflowColumnMap: Map<string, string>
): string[] {
  if (allColumns.size === 0) return [];

  // Collect all candidate column-level edges
  const candidateEdges: [string, string][] = [];
  for (const t of transitions) {
    const fromCol = workflowColumnMap.get(t.from_workflow_id);
    const toCol = workflowColumnMap.get(t.to_workflow_id);
    if (!fromCol || !toCol || fromCol === toCol) continue;
    if (!allColumns.has(fromCol) || !allColumns.has(toCol)) continue;
    candidateEdges.push([fromCol, toCol]);
  }

  // Build adjacency, skipping edges that would create a cycle
  const edges = new Map<string, Set<string>>();
  for (const col of allColumns) {
    edges.set(col, new Set());
  }

  for (const [from, to] of candidateEdges) {
    if (edges.get(from)!.has(to)) continue; // already added
    edges.get(from)!.add(to);
    if (hasCycle(allColumns, edges)) {
      edges.get(from)!.delete(to); // revert — this edge creates a cycle
    }
  }

  // Compute in-degree from the acyclic graph
  const inDegree = new Map<string, number>();
  for (const col of allColumns) {
    inDegree.set(col, 0);
  }
  for (const [, neighbors] of edges) {
    for (const neighbor of neighbors) {
      inDegree.set(neighbor, (inDegree.get(neighbor) ?? 0) + 1);
    }
  }

  // Identify terminal columns (no outgoing edges in the DAG)
  const terminal = new Set<string>();
  for (const col of allColumns) {
    if (edges.get(col)!.size === 0) {
      terminal.add(col);
    }
  }

  // Kahn's algorithm — break ties alphabetically, but defer terminal columns
  const queue: string[] = [];
  for (const [col, deg] of inDegree) {
    if (deg === 0) queue.push(col);
  }
  queue.sort(compareWithTerminalLast(terminal));

  const sorted: string[] = [];
  while (queue.length > 0) {
    const col = queue.shift()!;
    sorted.push(col);
    for (const neighbor of edges.get(col) ?? []) {
      const newDeg = (inDegree.get(neighbor) ?? 1) - 1;
      inDegree.set(neighbor, newDeg);
      if (newDeg === 0) {
        const cmp = compareWithTerminalLast(terminal);
        const idx = queue.findIndex((q) => cmp(q, neighbor) > 0);
        if (idx === -1) queue.push(neighbor);
        else queue.splice(idx, 0, neighbor);
      }
    }
  }

  return sorted;
}

/** Returns a comparator that sorts terminal columns after non-terminal, with alphabetical tiebreaking. */
function compareWithTerminalLast(terminal: Set<string>) {
  return (a: string, b: string) => {
    const aTerminal = terminal.has(a);
    const bTerminal = terminal.has(b);
    if (aTerminal !== bTerminal) return aTerminal ? 1 : -1;
    return a.localeCompare(b);
  };
}

/** DFS cycle detection on column-level adjacency. */
function hasCycle(
  nodes: Set<string>,
  edges: Map<string, Set<string>>
): boolean {
  const WHITE = 0,
    GRAY = 1,
    BLACK = 2;
  const color = new Map<string, number>();
  for (const n of nodes) color.set(n, WHITE);

  for (const n of nodes) {
    if (color.get(n) === WHITE && dfs(n)) return true;
  }
  return false;

  function dfs(node: string): boolean {
    color.set(node, GRAY);
    for (const neighbor of edges.get(node) ?? []) {
      const c = color.get(neighbor);
      if (c === GRAY) return true;
      if (c === WHITE && dfs(neighbor)) return true;
    }
    color.set(node, BLACK);
    return false;
  }
}

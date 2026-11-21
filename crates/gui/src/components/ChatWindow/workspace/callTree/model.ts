import type {
  ChangedSymbols,
  ComparisonCall,
  Side,
} from "../../../../bindings";

/** A call as written at one site, repeated calls counted. */
export interface CallNode {
  label: string;
  path: string;
  line: number;
  count: number;
}

export type RowChange = "same" | "added" | "removed";

/**
 * One aligned row of a call-tree diff: the call on each side, blank on the
 * side it is missing from. A fold stands for unchanged sibling calls.
 */
export type CallTreeRow =
  | {
      kind: "call";
      change: RowChange;
      depth: number;
      /** Tree guides before the label, shared by both columns. */
      guide: string;
      base?: CallNode;
      target?: CallNode;
    }
  | { kind: "fold"; depth: number; guide: string; count: number };

/** A changed function and how its calls changed beneath it. */
export interface CallTreeDiff {
  id: string;
  label: string;
  path: string;
  change: RowChange;
  base?: { path: string; line: number };
  target?: { path: string; line: number };
  rows: CallTreeRow[];
}

/** Lines a file's patch deleted (base numbering) and added (target numbering). */
export interface EditedLines {
  deleted: ReadonlySet<number>;
  added: ReadonlySet<number>;
}

/** Edited lines of a unified patch. */
export function editedLines(patch: string): EditedLines {
  const deleted = new Set<number>();
  const added = new Set<number>();
  let old = 0;
  let next = 0;
  let inHunk = false;
  for (const line of patch.split("\n")) {
    const hunk = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
    if (hunk) {
      old = Number(hunk[1]);
      next = Number(hunk[2]);
      inHunk = true;
    } else if (!inHunk || line.startsWith("\\")) {
      continue;
    } else if (line.startsWith("-")) {
      deleted.add(old++);
    } else if (line.startsWith("+")) {
      added.add(next++);
    } else {
      old++;
      next++;
    }
  }
  return { deleted, added };
}

/** Levels below the root; deeper changed calls stay leaves. */
export const MAX_DEPTH = 4;

interface Child {
  key: string;
  node: CallNode;
  /** The changed symbols the call may reach. */
  targets: readonly number[];
}

interface Branch {
  change: RowChange;
  base?: CallNode;
  target?: CallNode;
  children: Branch[];
  /** It or anything below it changed. */
  changed: boolean;
}

/** Calls each changed symbol makes, per side, in source order. */
function callsBySymbol(changes: ChangedSymbols) {
  const by = new Map<string, ComparisonCall[]>();
  for (const call of changes.calls) {
    if (call.changed_caller === null) continue;
    const key = `${call.changed_caller}:${call.side}`;
    const list = by.get(key) ?? [];
    list.push(call);
    by.set(key, list);
  }
  for (const list of by.values())
    list.sort(
      (a, b) =>
        a.call.site.line - b.call.site.line ||
        a.call.site.column - b.call.site.column
    );
  return (symbol: number, side: Side) => by.get(`${symbol}:${side}`) ?? [];
}

/**
 * A call on a literal (`"text".into`) or on another call's result
 * (`items.iter().map`) is expression plumbing, not a function-level call.
 */
function isPlumbing(callee: string): boolean {
  return /^["'`\d[]/.test(callee) || callee.includes("(");
}

/** One child per callee as written, in order of its first call. */
function children(calls: readonly ComparisonCall[]): Child[] {
  const out = new Map<string, Child>();
  for (const { call, changed_targets } of calls) {
    if (isPlumbing(call.callee)) continue;
    const existing = out.get(call.callee);
    if (existing) {
      existing.node.count += 1;
      continue;
    }
    out.set(call.callee, {
      key: call.callee,
      node: {
        label: call.callee,
        path: call.site.path,
        line: call.site.line,
        count: 1,
      },
      targets: changed_targets,
    });
  }
  return [...out.values()];
}

/** Align two ordered child lists; a reordered call is matched, not moved. */
function align(base: readonly Child[], target: readonly Child[]) {
  const n = base.length;
  const m = target.length;
  const lcs = Array.from({ length: n + 1 }, () =>
    new Array<number>(m + 1).fill(0)
  );
  for (let i = n - 1; i >= 0; i--)
    for (let j = m - 1; j >= 0; j--)
      lcs[i][j] =
        base[i].key === target[j].key
          ? lcs[i + 1][j + 1] + 1
          : Math.max(lcs[i + 1][j], lcs[i][j + 1]);
  const pairs: { base?: Child; target?: Child }[] = [];
  let i = 0;
  let j = 0;
  while (i < n || j < m) {
    if (i < n && j < m && base[i].key === target[j].key)
      pairs.push({ base: base[i++], target: target[j++] });
    // Removed before added, as in a line diff.
    else if (i < n && (j === m || lcs[i + 1][j] >= lcs[i][j + 1]))
      pairs.push({ base: base[i++] });
    else pairs.push({ target: target[j++] });
  }
  // A call present on both sides but out of order shows once, where the
  // target has it.
  const targetKeys = new Set(target.map((child) => child.key));
  const baseByKey = new Map(base.map((child) => [child.key, child]));
  return pairs
    .filter((pair) => pair.target || !targetKeys.has(pair.base!.key))
    .map((pair) =>
      pair.target && !pair.base && baseByKey.has(pair.target.key)
        ? { base: baseByKey.get(pair.target.key), target: pair.target }
        : pair
    );
}

/**
 * Call-tree diffs of a comparison, one per changed function that is not
 * itself called by another changed function. Each tree aligns the base's
 * calls with the target's; a call into another changed function opens
 * that function's calls on both sides. Calls into unchanged functions
 * are leaves: their own calls did not change.
 */
export function callTreeDiffs(
  changes: ChangedSymbols,
  /** The comparison's edited lines by path; base paths key deletions. */
  edits?: {
    deleted(path: string): ReadonlySet<number> | undefined;
    added(path: string): ReadonlySet<number> | undefined;
  }
): CallTreeDiff[] {
  const callsOf = callsBySymbol(changes);
  // A call missing from one side of a modified function is only added or
  // removed if the line diff edited its site; otherwise that side's read
  // was cut short and the call is unchanged.
  const edited = (side: Side, node: CallNode) => {
    const lines =
      side === "old" ? edits?.deleted(node.path) : edits?.added(node.path);
    return !edits || (lines?.has(node.line) ?? false);
  };
  const callers = new Set<number>();
  const called = new Set<number>();
  for (const call of changes.calls) {
    if (call.changed_caller === null) continue;
    callers.add(call.changed_caller);
    for (const target of call.changed_targets)
      if (target !== call.changed_caller) called.add(target);
  }
  let roots = [...callers].filter((symbol) => !called.has(symbol));
  // Changed functions that only call each other: show them all.
  if (roots.length === 0) roots = [...callers];

  const symbolChange = (symbol: number): RowChange => {
    const change = changes.symbols[symbol]?.change;
    return change === "added"
      ? "added"
      : change === "removed"
        ? "removed"
        : "same";
  };

  /** A one-sided call's change, within a function that changed as `change`. */
  const pairChange = (
    change: RowChange,
    base?: Child,
    target?: Child
  ): RowChange => {
    if (base && target) return "same";
    if (change !== "same") return change;
    if (base) return edited("old", base.node) ? "removed" : "same";
    return edited("new", target!.node) ? "added" : "same";
  };

  const branches = (
    symbol: number | undefined,
    change: RowChange,
    depth: number,
    path: ReadonlySet<number>
  ): Branch[] => {
    if (symbol === undefined || depth > MAX_DEPTH || path.has(symbol))
      return [];
    const inside = new Set(path).add(symbol);
    const base = change === "added" ? [] : children(callsOf(symbol, "old"));
    const target = change === "removed" ? [] : children(callsOf(symbol, "new"));
    const pairs = align(base, target).map(({ base, target }) => ({
      base,
      target,
      change: pairChange(change, base, target),
    }));
    return gapOrder(pairs).map(({ base, target, change: rowChange }) => {
      const next = (target ?? base)!.targets.find(
        (candidate) => candidate !== symbol
      );
      const below = branches(next, rowChange, depth + 1, inside);
      return {
        change: rowChange,
        base: base?.node,
        target: target?.node,
        children: below,
        changed: rowChange !== "same" || below.some((branch) => branch.changed),
      };
    });
  };

  const diffs: CallTreeDiff[] = [];
  for (const symbol of roots) {
    const changed = changes.symbols[symbol];
    if (!changed) continue;
    const change = symbolChange(symbol);
    const tree = branches(symbol, change, 1, new Set());
    if (change === "same" && !tree.some((branch) => branch.changed)) continue;
    const edit = changed.edits[0];
    const name = changed.id.scope.join(".") || changed.id.path;
    const line = (side: "old" | "new") => {
      const subject = edit?.declaration.subject;
      const at = side === "old" ? subject?.old_line : subject?.new_line;
      return at == null
        ? undefined
        : { path: side === "old" ? edit.old_path : edit.path, line: at };
    };
    diffs.push({
      id: `${changed.id.path}#${changed.id.scope.join(".")}#${changed.id.occurrence}`,
      label: name,
      path: changed.id.path,
      change,
      base: change === "added" ? undefined : line("old"),
      target: change === "removed" ? undefined : line("new"),
      rows: flatten(tree, 1, ""),
    });
  }
  return diffs.sort(
    (a, b) => a.path.localeCompare(b.path) || a.label.localeCompare(b.label)
  );
}

/**
 * Within each run of one-sided calls: removed, then added, then calls one
 * side's cut-short read missed, which belong to the run's tail.
 */
function gapOrder<
  T extends { base?: unknown; target?: unknown; change: RowChange },
>(pairs: readonly T[]): T[] {
  const rank = { removed: 0, added: 1, same: 2 } as const;
  const out: T[] = [];
  let run: T[] = [];
  const flush = () => {
    out.push(...run.sort((a, b) => rank[a.change] - rank[b.change]));
    run = [];
  };
  for (const pair of pairs) {
    if (pair.base && pair.target) {
      flush();
      out.push(pair);
    } else run.push(pair);
  }
  flush();
  return out;
}

/** Rows in tree order; runs of two or more unchanged leaves fold. */
function flatten(
  branches: readonly Branch[],
  depth: number,
  indent: string
): CallTreeRow[] {
  type Item = { branch: Branch } | { fold: number };
  const items: Item[] = [];
  for (let index = 0; index < branches.length; ) {
    let end = index;
    while (end < branches.length && !branches[end].changed) end++;
    if (end - index >= 2) {
      items.push({ fold: end - index });
      index = end;
    } else {
      items.push({ branch: branches[index++] });
    }
  }
  const rows: CallTreeRow[] = [];
  items.forEach((item, index) => {
    const last = index === items.length - 1;
    const guide = `${indent}${last ? "└─ " : "├─ "}`;
    if ("fold" in item) {
      rows.push({ kind: "fold", depth, guide, count: item.fold });
      return;
    }
    const { branch } = item;
    rows.push({
      kind: "call",
      change: branch.change,
      depth,
      guide,
      base: branch.base,
      target: branch.target,
    });
    if (branch.changed && branch.children.length > 0)
      rows.push(
        ...flatten(
          branch.children,
          depth + 1,
          `${indent}${last ? "   " : "│  "}`
        )
      );
  });
  return rows;
}

/**
 * Test-only unified diff writer mirroring the production patch format
 * (`worktree_delta/patch.rs`): Git headers, 3 lines of context and real
 * `@@ -a,b +c,d @@` headers.
 */

type Op = { tag: "eq" | "del" | "add"; text: string };

/** Line diff by longest common subsequence. */
export function diffOps(a: readonly string[], b: readonly string[]): Op[] {
  const n = a.length;
  const m = b.length;
  const table: number[][] = Array.from({ length: n + 1 }, () =>
    new Array<number>(m + 1).fill(0)
  );
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      table[i][j] =
        a[i] === b[j]
          ? table[i + 1][j + 1] + 1
          : Math.max(table[i + 1][j], table[i][j + 1]);
    }
  }
  const ops: Op[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      ops.push({ tag: "eq", text: a[i] });
      i++;
      j++;
    } else if (table[i + 1][j] >= table[i][j + 1]) {
      ops.push({ tag: "del", text: a[i++] });
    } else {
      ops.push({ tag: "add", text: b[j++] });
    }
  }
  while (i < n) ops.push({ tag: "del", text: a[i++] });
  while (j < m) ops.push({ tag: "add", text: b[j++] });
  return ops;
}

function range(start0: number, count: number): string {
  const start = count === 0 ? start0 : start0 + 1;
  return count === 1 ? `${start}` : `${start},${count}`;
}

/** Hunk text (headers and rows) for the difference between two line lists. */
export function hunksFor(
  a: readonly string[],
  b: readonly string[],
  context = 3
): string {
  const ops = diffOps(a, b);
  const changed = ops
    .map((op, index) => (op.tag === "eq" ? -1 : index))
    .filter((index) => index >= 0);
  if (changed.length === 0) return "";

  const groups: Array<[number, number]> = [];
  for (const index of changed) {
    const from = Math.max(0, index - context);
    const to = Math.min(ops.length - 1, index + context);
    const last = groups[groups.length - 1];
    if (last && from <= last[1] + 1) last[1] = Math.max(last[1], to);
    else groups.push([from, to]);
  }

  // Old/new line counts consumed before each op index.
  const before: Array<[number, number]> = [];
  let o = 0;
  let nw = 0;
  for (const op of ops) {
    before.push([o, nw]);
    if (op.tag !== "add") o++;
    if (op.tag !== "del") nw++;
  }

  const out: string[] = [];
  for (const [from, to] of groups) {
    const slice = ops.slice(from, to + 1);
    const oldCount = slice.filter((op) => op.tag !== "add").length;
    const newCount = slice.filter((op) => op.tag !== "del").length;
    out.push(
      `@@ -${range(before[from][0], oldCount)} +${range(before[from][1], newCount)} @@`
    );
    for (const op of slice) {
      out.push(
        `${op.tag === "eq" ? " " : op.tag === "del" ? "-" : "+"}${op.text}`
      );
    }
  }
  return out.join("\n");
}

/** A Git-format patch for one file; `null` content means the file is absent. */
export function filePatch(options: {
  oldPath?: string;
  path: string;
  before: readonly string[] | null;
  after: readonly string[] | null;
  context?: number;
}): string {
  const { path, before, after, context } = options;
  const oldPath = options.oldPath ?? path;
  const lines = [`diff --git a/${oldPath} b/${path}`];
  if (before === null) lines.push("new file mode 100644");
  else if (after === null) lines.push("deleted file mode 100644");
  else if (oldPath !== path) {
    lines.push(
      "similarity index 100%",
      `rename from ${oldPath}`,
      `rename to ${path}`
    );
  }
  const body = hunksFor(before ?? [], after ?? [], context);
  if (body) {
    lines.push(
      `--- ${before === null ? "/dev/null" : `a/${oldPath}`}`,
      `+++ ${after === null ? "/dev/null" : `b/${path}`}`,
      body
    );
  }
  return `${lines.join("\n")}\n`;
}

/** `[prefix1, prefix2, ...]` lines named `prefix1..prefixN`. */
export function numbered(prefix: string, count: number): string[] {
  return Array.from({ length: count }, (_, i) => `${prefix}${i + 1}`);
}

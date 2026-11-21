import { describe, expect, it } from "vitest";
import type {
  ChangedSymbol,
  ChangedSymbols,
  CodeSymbol,
  ComparisonCall,
  EditKind,
  Side,
} from "../../../../bindings";
import { callTreeDiffs, editedLines, type CallTreeRow } from "./model";

const PATH = "src/orders.ts";

const fn = (name: string, line: number): CodeSymbol => ({
  path: PATH,
  name,
  kind: "function",
  span: { start: line, end: line + 5 },
  line,
  scope: [],
});

const symbol = (name: string, change: EditKind, line: number): ChangedSymbol =>
  ({
    id: { path: PATH, scope: [name], kind: "function", occurrence: 0 },
    change,
    edits: [
      {
        path: PATH,
        old_path: PATH,
        index: 0,
        old_revision: "base",
        new_revision: "target",
        declaration: {
          subject: {
            kind: "function",
            keyword: "function",
            name,
            old_line: change === "added" ? null : line,
            new_line: change === "removed" ? null : line,
          },
        },
      },
    ],
    effects: [],
  }) as unknown as ChangedSymbol;

const call = (
  side: Side,
  caller: number,
  callee: string,
  line: number,
  targets: number[] = []
): ComparisonCall => ({
  side,
  call: {
    caller: fn("caller", 1),
    callee,
    site: { path: PATH, line, column: 3 },
    resolution: { quality: "unresolved" },
  },
  changed_caller: caller,
  changed_targets: targets,
  effect: null,
  callee_effects: [],
});

/** submit (modified) stops validating, calls a new price(), which logs. */
const CHANGES: ChangedSymbols = {
  provider: "embedded",
  incomplete: false,
  symbols: [
    symbol("submit", "modified", 10),
    symbol("price", "added", 30),
    symbol("validate", "removed", 40),
  ],
  calls: [
    call("old", 0, "load", 11),
    call("old", 0, "validate", 12, [2]),
    call("old", 0, "audit", 13),
    call("old", 0, "track", 14),
    call("old", 0, "save", 15),
    call("old", 2, "check", 41),
    call("new", 0, "load", 11),
    call("new", 0, "price", 12, [1]),
    call("new", 0, "audit", 13),
    call("new", 0, "track", 14),
    call("new", 0, "save", 15),
    call("new", 0, "save", 16),
    call("new", 1, "log", 31),
  ],
};

const text = (row: CallTreeRow) =>
  row.kind === "fold"
    ? `  ${row.guide}… ${row.count}`
    : `${{ same: " ", added: "+", removed: "-" }[row.change]} ${row.guide}${(row.base ?? row.target)!.label}`;

describe("callTreeDiffs", () => {
  it("diffs a changed function's calls, opening changed callees on their side", () => {
    const [tree, ...rest] = callTreeDiffs(CHANGES);
    // price and validate are reached from submit, so submit is the only root.
    expect(rest).toEqual([]);
    expect(tree.label).toBe("submit");
    expect(tree.target).toEqual({ path: PATH, line: 10 });
    expect(tree.rows.map(text)).toEqual([
      "  ├─ load",
      "- ├─ validate",
      "- │  └─ check",
      "+ ├─ price",
      "+ │  └─ log",
      "  └─ … 3",
    ]);
  });

  it("aligns each call on both sides and counts repeated calls", () => {
    const [tree] = callTreeDiffs(CHANGES);
    const removed = tree.rows.find(
      (row) => row.kind === "call" && row.change === "removed"
    );
    expect(removed).toMatchObject({
      base: { label: "validate", line: 12 },
      target: undefined,
    });
    const same = tree.rows[0];
    expect(same).toMatchObject({
      base: { label: "load" },
      target: { label: "load" },
    });

    const unfolded = callTreeDiffs({
      ...CHANGES,
      calls: CHANGES.calls.filter(
        (entry) => !["audit", "track"].includes(entry.call.callee)
      ),
    })[0];
    expect(unfolded.rows.at(-1)).toMatchObject({
      target: { label: "save", count: 2 },
    });
  });

  it("shows a reordered call once, and leaves out functions whose calls did not change", () => {
    const reordered: ChangedSymbols = {
      ...CHANGES,
      symbols: [symbol("submit", "modified", 10)],
      calls: [
        call("old", 0, "load", 11),
        call("old", 0, "save", 12),
        call("new", 0, "save", 11),
        call("new", 0, "load", 12),
      ],
    };
    expect(callTreeDiffs(reordered)).toEqual([]);
  });

  it("leaves out calls on literals and on other calls' results", () => {
    const plumbing: ChangedSymbols = {
      ...CHANGES,
      symbols: [symbol("submit", "modified", 10)],
      calls: [
        call("new", 0, '"failed".into', 11),
        call("new", 0, "items.iter().map", 12),
        call("new", 0, "Order::new", 13),
      ],
    };
    expect(callTreeDiffs(plumbing)[0].rows.map(text)).toEqual([
      "+ └─ Order::new",
    ]);
  });

  it("bounds recursion", () => {
    const recursive: ChangedSymbols = {
      ...CHANGES,
      symbols: [symbol("walk", "added", 1)],
      calls: [call("new", 0, "walk", 2, [0]), call("new", 0, "visit", 3)],
    };
    const [tree] = callTreeDiffs(recursive);
    expect(tree.change).toBe("added");
    expect(tree.rows.map(text)).toEqual(["+ ├─ walk", "+ └─ visit"]);
  });

  it("keeps a call missing from a side whose read was cut short when its line did not change", () => {
    // The target's read of submit stopped after price; the patch only
    // edited line 12, so audit, track and save are still there.
    const cutShort: ChangedSymbols = {
      ...CHANGES,
      incomplete: true,
      calls: CHANGES.calls.filter(
        (entry) =>
          entry.side === "old" ||
          entry.call.site.line <= 12 ||
          entry.changed_caller !== 0
      ),
    };
    const lines = editedLines("@@ -12 +12 @@\n-  validate();\n+  price();\n");
    const [tree] = callTreeDiffs(cutShort, {
      deleted: (path) => (path === PATH ? lines.deleted : undefined),
      added: (path) => (path === PATH ? lines.added : undefined),
    });
    expect(tree.rows.map(text)).toEqual([
      "  ├─ load",
      "- ├─ validate",
      "- │  └─ check",
      "+ ├─ price",
      "+ │  └─ log",
      "  └─ … 3",
    ]);
  });
});

describe("editedLines", () => {
  it("numbers deletions on the base and additions on the target", () => {
    const patch = [
      "--- a/src/orders.ts",
      "+++ b/src/orders.ts",
      "@@ -3,4 +3,5 @@ function submit()",
      " load();",
      "-validate();",
      "+price();",
      "+log();",
      " save();",
      "\\ No newline at end of file",
      "@@ -20 +21 @@",
      "-a",
      "+b",
    ].join("\n");
    const { deleted, added } = editedLines(patch);
    expect([...deleted]).toEqual([4, 20]);
    expect([...added]).toEqual([4, 5, 21]);
  });
});

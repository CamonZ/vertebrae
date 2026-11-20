import { describe, expect, it } from "vitest";
import type {
  DeclarationDiff,
  Fact,
  Facts,
  LineSpan,
  Part,
  ScopeSegment,
} from "../../../bindings";
import { parsePatch } from "../../thread/toolChange/diffLineMapper";
import {
  MAX_REVEAL,
  chipText,
  semanticHunks,
  summaryCounts,
  summaryDetail,
} from "./semanticHunks";

const patch = (body: string) =>
  parsePatch(`diff --git a/f.ts b/f.ts\n--- a/f.ts\n+++ b/f.ts\n${body}`)[0];

const KINDS: Record<string, ScopeSegment["kind"]> = {
  function: "function",
  fn: "method",
  impl: "impl",
  struct: "class",
  field: "field",
};

const scope = (
  name: string,
  oldLine: number | null,
  newLine: number | null,
  keyword = "function"
): ScopeSegment => ({
  kind: KINDS[keyword] ?? "function",
  keyword,
  name,
  old_line: oldLine,
  new_line: newLine,
});

const at = (line: number) => ({ start: line, end: line });

const NO_FACTS: Facts = { items: [], omitted: 0 };

/** Code inside the innermost of `segments` changed. */
const modified = (
  segments: ScopeSegment[],
  ...parts: Part[]
): DeclarationDiff => ({
  scope: segments.slice(0, -1),
  subject: segments.at(-1) ?? null,
  change: { kind: "modified" },
  facts: NO_FACTS,
  parts,
});

const update = (
  line: number,
  segments: ScopeSegment[],
  signature = false
): DeclarationDiff =>
  modified(
    segments,
    signature
      ? { kind: "signature", old: at(line), new: at(line), facts: NO_FACTS }
      : { kind: "changed", old: at(line), new: at(line), facts: NO_FACTS }
  );

/** A whole-declaration change; an addition or removal's head defaults to its first line. */
type WholeChange =
  | DeclarationDiff["change"]
  | { kind: "added"; new: LineSpan }
  | { kind: "removed"; old: LineSpan };

/** The innermost of `segments` changed as a whole. */
const declaring = (
  change: WholeChange,
  segments: ScopeSegment[],
  facts: Facts = NO_FACTS
): DeclarationDiff => ({
  scope: segments.slice(0, -1),
  subject: segments.at(-1) ?? null,
  change:
    change.kind === "added" && !("head" in change)
      ? { ...change, head: change.new.start }
      : change.kind === "removed" && !("head" in change)
        ? { ...change, head: change.old.start }
        : change,
  facts,
  parts: [],
});

describe("semanticHunks", () => {
  it("opens a hunk at its function's signature and labels the scope", () => {
    // `export default function f(` on line 10; the change on line 15.
    const file = patch(
      "@@ -12,7 +12,7 @@\n   a();\n   b();\n   c();\n-  count += 1;\n+  count += 2;\n   d();\n   e();\n   f();\n"
    );
    const view = semanticHunks(file, [update(15, [scope("f", 10, 10)])]);
    // Lines 10 and 11 are revealed above the hunk starting at 12.
    expect(view.reveals.get(0)).toEqual({ top: 0, bottom: 2 });
    expect(view.labels).toEqual([
      {
        side: "additions",
        lineNumber: 15,
        scope: [scope("f", 10, 10)],
        chips: [{ kind: "changed" }],
        facts: [],
        test: false,
      },
    ]);
    expect(view.formattingOnly).toBe(false);
  });

  it("marks whitespace-only blocks as formatting and nothing else", () => {
    const file = patch(
      "@@ -1,3 +1,6 @@\n-fn add(a: i32, b: i32) -> i32 { a + b }\n+fn add(a: i32, b: i32) -> i32 {\n+    a\n+        + b\n+}\n \n fn other() {}\n"
    );
    const view = semanticHunks(file, []);
    expect(view.formattingOnly).toBe(true);
    expect(view.reveals.size).toBe(0);
    expect(view.labels.map((label) => label.chips)).toEqual([
      [{ kind: "formatting" }],
    ]);
  });

  it("leaves a changed block without a syntax change unlabelled, never hidden", () => {
    // The line diff's half of a move reported elsewhere in the file.
    const file = patch("@@ -1,2 +1,2 @@\n-fn f2() {}\n+fn f3() {}\n x\n");
    const moved = declaring({ kind: "moved", old: at(40), new: at(60) }, [
      scope("g", 40, 60, "fn"),
    ]);
    const view = semanticHunks(file, [moved]);
    expect(view.formattingOnly).toBe(false);
    expect(view.labels).toEqual([]);
  });

  it("joins a rename's hunks inside one declaration under one label", () => {
    const rename = modified([scope("total", 1, 1, "fn")], {
      kind: "renamed",
      old: at(2),
      new: at(2),
      from: "sum",
      to: "acc",
      sites: [2, 9, 16].map((line) => ({ old_line: line, new_line: line })),
      facts: NO_FACTS,
    });
    const lines = (from: number, to: number) =>
      Array.from(
        { length: to - from + 1 },
        (_, i) => ` line${from + i}\n`
      ).join("");
    const file = patch(
      `@@ -1,5 +1,5 @@\n${lines(1, 1)}-  let mut sum = 0;\n+  let mut acc = 0;\n${lines(3, 5)}` +
        `@@ -6,7 +6,7 @@\n${lines(6, 8)}-  sum += 1;\n+  acc += 1;\n${lines(10, 12)}` +
        `@@ -13,7 +13,7 @@\n${lines(13, 15)}-  sum\n+  acc\n${lines(17, 19)}`
    );
    const view = semanticHunks(file, [rename]);
    // Gaps between the hunks are empty here, so nothing needs revealing;
    // one label covers all three sites.
    expect(view.labels).toHaveLength(1);
    expect(view.labels[0].lineNumber).toBe(2);
    expect(view.labels[0].chips.map(chipText)).toEqual(["renamed sum → acc"]);
  });

  it("reveals the gap between two hunks of one declaration", () => {
    const file = patch(
      "@@ -2,7 +2,7 @@\n a\n b\n c\n-x = 1\n+x = 2\n d\n e\n f\n" +
        "@@ -20,7 +20,7 @@\n g\n h\n i\n-y = 1\n+y = 2\n j\n k\n l\n"
    );
    const big = modified(
      [scope("big", 1, 1)],
      { kind: "changed", old: at(5), new: at(5), facts: NO_FACTS },
      { kind: "changed", old: at(23), new: at(23), facts: NO_FACTS }
    );
    const view = semanticHunks(file, [big]);
    expect(view.reveals.get(0)).toEqual({ top: 0, bottom: 1 });
    // Lines 9..19 between the hunks.
    expect(view.reveals.get(1)).toEqual({ top: 11, bottom: 0 });
    expect(view.labels).toHaveLength(1);
  });

  it("labels both copies of a moved function with links to each other", () => {
    const move = declaring(
      { kind: "moved", old: { start: 2, end: 4 }, new: { start: 7, end: 9 } },
      [scope("Account", 1, 1, "impl"), scope("deposit", 2, 7, "fn")]
    );
    const file = patch(
      "@@ -1,6 +1,2 @@\n impl Account {\n-    fn deposit() {\n-        1\n-    }\n-\n     fn withdraw() {\n" +
        "@@ -9,1 +5,5 @@\n     }\n+\n+    fn deposit() {\n+        1\n+    }\n"
    );
    const view = semanticHunks(file, [move]);
    const texts = view.labels.map((label) => [
      label.side,
      label.lineNumber,
      label.chips.map(chipText),
    ]);
    expect(texts).toEqual([
      ["deletions", 2, ["moved fn deposit to L7"]],
      ["additions", 6, ["moved fn deposit from L2"]],
    ]);
    // The function is named on the chip, under the scope around it.
    expect(view.labels[0].scope.map((s) => s.name)).toEqual(["Account"]);
  });

  it("does not reveal a declaration that opens far above its hunk", () => {
    const start = 100;
    const file = patch(`@@ -${start},3 +${start},3 @@\n a\n-b\n+c\n d\n`);
    const view = semanticHunks(file, [
      update(start + 1, [
        scope("far", start - MAX_REVEAL - 5, start - MAX_REVEAL - 5),
      ]),
    ]);
    expect(view.reveals.size).toBe(0);
    expect(view.labels[0].scope[0].name).toBe("far");
  });

  it("labels signature changes without a generic 'changed'", () => {
    const file = patch(
      "@@ -1,2 +1,2 @@\n-function f(a: number) {\n+function f(a: string) {\n   return a;\n"
    );
    const view = semanticHunks(file, [update(1, [scope("f", 1, 1)], true)]);
    expect(view.labels[0].chips.map(chipText)).toEqual(["signature changed"]);
  });
});

it("reads a removal and an addition in one block as a change", () => {
  const file = patch(
    "@@ -1,1 +1,1 @@\n-  contents: source,\n+  contents: source.trimEnd(),\n"
  );
  const view = semanticHunks(file, [
    modified(
      [scope("f", 1, 1)],
      { kind: "removed", old: at(1), facts: NO_FACTS },
      { kind: "added", new: at(1), facts: NO_FACTS }
    ),
  ]);
  expect(view.labels[0].chips.map(chipText)).toEqual(["changed"]);
});

describe("declarations", () => {
  it("labels each added declaration where it starts, named on its chip", () => {
    // Two functions added to an impl in one block of added lines.
    const file = patch(
      "@@ -1,3 +1,10 @@\n impl Account {\n     fn a() {}\n+\n+    /// Resets.\n+    fn reset() {}\n+\n+    fn clear() {\n+        1\n+    }\n }\n"
    );
    const impl = scope("Account", 1, 1, "impl");
    const view = semanticHunks(file, [
      declaring({ kind: "added", new: { start: 4, end: 5 } }, [
        impl,
        scope("reset", null, 5, "fn"),
      ]),
      declaring({ kind: "added", new: { start: 7, end: 9 } }, [
        impl,
        scope("clear", null, 7, "fn"),
      ]),
    ]);
    expect(
      view.labels.map((label) => [
        label.lineNumber,
        label.scope.map((s) => s.name),
        label.chips.map(chipText),
      ])
    ).toEqual([
      [4, ["Account"], ["added fn reset"]],
      [7, ["Account"], ["added fn clear"]],
    ]);
    expect(summaryCounts(view.summary)).toBe("2 added");
    expect(summaryDetail(view.summary)).toBe("added fn reset\nadded fn clear");
  });

  it("labels a removed declaration on the deleted side", () => {
    const file = patch("@@ -1,4 +1,1 @@\n struct P {}\n-\n-fn gone() {\n-}\n");
    const view = semanticHunks(file, [
      declaring({ kind: "removed", old: { start: 3, end: 4 } }, [
        scope("gone", 3, null, "fn"),
      ]),
    ]);
    expect(view.labels).toEqual([
      {
        side: "deletions",
        lineNumber: 3,
        scope: [],
        chips: [
          { kind: "removed", declaration: { keyword: "fn", name: "gone" } },
        ],
        facts: [],
        test: false,
      },
    ]);
  });

  it("names a renamed declaration and counts every kind in the summary", () => {
    const file = patch("@@ -1,1 +1,1 @@\n-fn total() {}\n+fn count() {}\n");
    const rename = declaring(
      {
        kind: "renamed",
        old: at(1),
        new: at(1),
        from: "total",
        to: "count",
        sites: [{ old_line: 1, new_line: 1 }],
      },
      [scope("count", 1, 1, "fn")]
    );
    const moved = declaring({ kind: "moved", old: at(9), new: at(20) }, [
      scope("a", 9, 20, "fn"),
    ]);
    const removed = declaring({ kind: "removed", old: at(30) }, [
      scope("b", 30, null, "fn"),
    ]);
    const view = semanticHunks(file, [rename, moved, removed]);
    expect(view.labels[0].chips.map(chipText)).toEqual([
      "renamed fn total → count",
    ]);
    expect(summaryCounts(view.summary)).toBe("1 removed · 1 renamed · 1 moved");
  });

});

it("puts a moved declaration's old-copy label on its deleted line", () => {
  // `audit` moves up; `reset` is added where `audit` was, in one block.
  const file = patch(
    "@@ -1,6 +1,6 @@\n impl Account {\n-    fn audit() {}\n+    /// Resets.\n+    fn reset() {}\n }\n"
  );
  const impl = scope("Account", 1, 1, "impl");
  const view = semanticHunks(file, [
    declaring({ kind: "moved", old: at(2), new: at(40) }, [
      impl,
      scope("audit", 2, 40, "fn"),
    ]),
    declaring({ kind: "added", new: { start: 2, end: 3 } }, [
      impl,
      scope("reset", null, 3, "fn"),
    ]),
  ]);
  expect(
    view.labels.map((label) => [
      label.side,
      label.lineNumber,
      label.chips.map(chipText),
    ])
  ).toEqual([
    ["deletions", 2, ["moved fn audit to L40"]],
    ["additions", 2, ["added fn reset"]],
  ]);
});

it("names a block label's scope after the changes it describes", () => {
  // One git block: `describe` moved away and a field added to `Options`.
  const file = patch(
    "@@ -1,4 +1,3 @@\n interface Options {\n   retries: number;\n-}\n-function describe() {}\n+  timeoutMs?: number;\n+}\n"
  );
  const options = scope("Options", 1, 1, "struct");
  const view = semanticHunks(file, [
    declaring({ kind: "moved", old: at(4), new: at(30) }, [
      scope("describe", 4, 30, "function"),
    ]),
    declaring({ kind: "added", new: at(3) }, [
      options,
      scope("timeoutMs", null, 3, "field"),
    ]),
  ]);
  const moved = view.labels.find((label) =>
    label.chips.some((chip) => chip.kind === "moved")
  );
  expect(moved?.scope).toEqual([]);
  // On `describe` itself, not on the `}` the line diff paired with the field.
  expect([moved?.side, moved?.lineNumber]).toEqual(["deletions", 4]);
  expect(moved?.chips.map(chipText)).toEqual([
    "moved function describe to L30",
  ]);
});

const facts = (...items: Fact[]): Facts => ({ items, omitted: 0 });
const added = (subject: string) => ({ kind: "added" as const, subject });
const call = (subject: string): Fact => ({ kind: { type: "call" }, change: added(subject) });
const literal: Fact = {
  kind: { type: "literal" },
  change: { kind: "changed", from: "1", to: "2" },
};
const write: Fact = {
  kind: { type: "effect", effect: "filesystem" },
  change: added("std::fs::write"),
};
const early: Fact = { kind: { type: "early_return" }, change: added("return") };
const inTest: Fact = { kind: { type: "test_code" }, change: { kind: "inside" } };

describe("label facts", () => {
  it("puts a block's facts on its label in category order, once each", () => {
    const file = patch(
      "@@ -1,4 +1,5 @@\n fn f() {\n-    let x = 1;\n+    let x = 2;\n+    retry();\n     done();\n }\n"
    );
    const view = semanticHunks(file, [
      modified(
        [scope("f", 1, 1, "fn")],
        { kind: "changed", old: at(2), new: at(2), facts: facts(literal) },
        { kind: "added", new: at(3), facts: facts(early, call("retry"), write, literal) }
      ),
    ]);
    expect(view.labels).toHaveLength(1);
    expect(view.labels[0].facts).toEqual([
      {
        owner: { keyword: "fn", name: "f" },
        whole: false,
        facts: [write, early, call("retry"), literal],
        omitted: 0,
      },
    ]);
  });

  it("labels an added declaration at its head, with its facts as a whole", () => {
    // Lines 1–2 are the comment and attribute before `fn g`.
    const file = patch(
      "@@ -1,0 +1,5 @@\n+// Reads it.\n+#[inline]\n+fn g() {\n+    retry();\n+}\n"
    );
    const view = semanticHunks(file, [
      declaring(
        { kind: "added", new: { start: 1, end: 5 }, head: 3 },
        [scope("g", null, 3, "fn")],
        { items: [call("retry")], omitted: 2 }
      ),
    ]);
    expect(view.labels.map((label) => [label.lineNumber, label.facts])).toEqual([
      [
        3,
        [
          {
            owner: { keyword: "fn", name: "g" },
            whole: true,
            facts: [call("retry")],
            omitted: 2,
          },
        ],
      ],
    ]);
  });

  it("keeps the facts of two declarations on one line apart", () => {
    const file = patch("@@ -1,0 +1,1 @@\n+fn a() { load(); } fn b() { save(); }\n");
    const view = semanticHunks(file, [
      declaring({ kind: "added", new: at(1) }, [scope("a", null, 1, "fn")], facts(call("load"))),
      declaring({ kind: "added", new: at(1) }, [scope("b", null, 1, "fn")], facts(call("save"))),
    ]);
    expect(view.labels).toHaveLength(1);
    expect(
      view.labels[0].facts.map((group) => [group.owner?.name, group.facts])
    ).toEqual([
      ["a", [call("load")]],
      ["b", [call("save")]],
    ]);
  });

  it("marks a label in test code instead of listing it as a fact", () => {
    const file = patch("@@ -2,1 +2,1 @@\n-    go(1);\n+    go(2);\n");
    const view = semanticHunks(file, [
      modified(
        [scope("t", 1, 1, "fn")],
        { kind: "changed", old: at(2), new: at(2), facts: facts(literal, inTest) }
      ),
    ]);
    expect(view.labels[0].test).toBe(true);
    expect(view.labels[0].facts.flatMap((group) => group.facts)).toEqual([literal]);
  });
});

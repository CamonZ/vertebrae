import { describe, test } from "vitest";
import * as hegel from "@hegeldev/hegel";
import * as gs from "@hegeldev/hegel/generators";
import {
  canonicalPath,
  chunkPatch,
  findRow,
  parsePatch,
  projectToolRowToWorktree,
  projectWorktreeRowToToolCall,
  rowLine,
  spanChunk,
  type FilePatch,
  type ToolPatch,
} from "./diffLineMapper";
import { drawScenario, type Scenario } from "./diffScenario.test.helpers";

function check(condition: boolean, message: string): void {
  if (!condition) throw new Error(message);
}

function setup(scenario: Scenario) {
  const chain: ToolPatch[] = scenario.calls.map((call, i) => ({
    id: `t${i}`,
    files: parsePatch(call.patch),
  }));
  const worktree = parsePatch(scenario.worktreePatch);
  return { chain, worktree };
}

function fileOf(files: readonly FilePatch[]): FilePatch | undefined {
  return files[0];
}

describe("diff line mapper (unique lines, identity ground truth)", () => {
  test("every landing rule matches the per-line identity model", () =>
    hegel.test((tc) => {
      const scenario = drawScenario(tc, true);
      const { chain, worktree } = setup(scenario);
      const worktreeFile = fileOf(worktree);
      const baselineIds = new Map(
        scenario.baseline.map((l, i) => [l.id, i + 1] as const)
      );
      const finalIds = new Map(
        scenario.final.map((l, i) => [l.id, i + 1] as const)
      );

      scenario.calls.forEach((call, k) => {
        const file = fileOf(chain[k].files);
        if (!file) return;
        for (const hunk of file.hunks) {
          for (const row of hunk.rows) {
            const source =
              row.kind === "del"
                ? call.before[row.oldLine! - 1]
                : call.after[row.newLine! - 1];
            const target = worktreeFile
              ? projectToolRowToWorktree(chain, k, file, row, worktree)
              : null;
            if (row.kind === "del") {
              const base = baselineIds.get(source.id);
              check(
                (target !== null) === (base !== undefined),
                `call ${k}: removed line ${source.id} landing mismatch`
              );
              if (target && base !== undefined) {
                check(
                  target.location.row.kind === "del" &&
                    target.location.row.oldLine === base,
                  `call ${k}: removed line ${source.id} landed at wrong line`
                );
              }
            } else {
              const final = finalIds.get(source.id);
              if (target) {
                check(final !== undefined, `call ${k}: ${source.id} not final`);
                check(
                  target.location.row.newLine === final,
                  `call ${k}: line ${source.id} landed at wrong line`
                );
                check(
                  target.location.row.kind ===
                    (baselineIds.has(source.id) ? "context" : "add"),
                  `call ${k}: line ${source.id} landed on wrong row kind`
                );
              } else if (final !== undefined && worktreeFile) {
                // Only lines outside every All Changes hunk may be missing.
                const shown = worktreeFile.hunks.some((h) =>
                  h.rows.some((r) => r.newLine === final)
                );
                check(!shown, `call ${k}: shown line ${source.id} not mapped`);
              }
            }
            if (target) {
              check(
                target.location.row.text === row.text,
                "mapped text differs from source text"
              );
              check(
                canonicalPath(target.file) === scenario.finalPath,
                "landed on the wrong file"
              );
            }
          }
        }
      });
    }));

  test("each All Changes row lands on the one call that produced it", () =>
    hegel.test((tc) => {
      const scenario = drawScenario(tc, true);
      const { chain, worktree } = setup(scenario);
      const file = fileOf(worktree);
      if (!file) return;
      for (const hunk of file.hunks) {
        for (const row of hunk.rows) {
          const target = projectWorktreeRowToToolCall(chain, file, row);
          if (row.kind === "context") {
            check(target === null, "context row must have no producing call");
            continue;
          }
          const id =
            row.kind === "add"
              ? scenario.final[row.newLine! - 1].id
              : scenario.baseline[row.oldLine! - 1].id;
          const producer = scenario.calls.findIndex((call) =>
            row.kind === "add"
              ? !call.before.some((l) => l.id === id) &&
                call.after.some((l) => l.id === id)
              : call.before.some((l) => l.id === id) &&
                !call.after.some((l) => l.id === id)
          );
          check(producer >= 0, "a changed All Changes row has a producer");
          check(target !== null, `row ${row.kind} ${id} was not projected`);
          check(target!.patchIndex === producer, "wrong producing call");
          const callRow = target!.location.row;
          const callLine =
            row.kind === "add"
              ? scenario.calls[producer].after.findIndex((l) => l.id === id) + 1
              : scenario.calls[producer].before.findIndex((l) => l.id === id) +
                1;
          check(
            (row.kind === "add" ? callRow.newLine : callRow.oldLine) ===
              callLine,
            "wrong line in the producing call"
          );
        }
      }
    }));

  test("tool call -> All Changes -> tool call returns the original row", () =>
    hegel.test((tc) => {
      const scenario = drawScenario(tc, true);
      const { chain, worktree } = setup(scenario);
      checkRoundTrip(chain, worktree);
    }));
});

function checkRoundTrip(
  chain: readonly ToolPatch[],
  worktree: readonly FilePatch[]
): void {
  chain.forEach((patch, k) => {
    for (const file of patch.files) {
      for (const hunk of file.hunks) {
        for (const row of hunk.rows) {
          const forward = projectToolRowToWorktree(
            chain,
            k,
            file,
            row,
            worktree
          );
          if (!forward) continue;
          check(forward.location.row.text === row.text, "text changed");
          // Only rows the call itself changed have a single producing call.
          if (
            row.kind === "context" ||
            forward.location.row.kind === "context"
          ) {
            continue;
          }
          const back = projectWorktreeRowToToolCall(
            chain,
            forward.file,
            forward.location.row
          );
          check(back !== null, "round trip lost the row");
          check(back!.patchIndex === k, "round trip changed the call");
          check(back!.location.row === row, "round trip changed the row");
        }
      }
    }
  });
}

describe("diff line mapper (repeated lines)", () => {
  test("mapped lines keep their text and round trip", () =>
    hegel.test((tc) => {
      const scenario = drawScenario(tc, false);
      const { chain, worktree } = setup(scenario);
      checkRoundTrip(chain, worktree);
      const file = fileOf(worktree);
      if (!file) return;
      for (const hunk of file.hunks) {
        for (const row of hunk.rows) {
          const target = projectWorktreeRowToToolCall(chain, file, row);
          if (target) {
            check(target.location.row.text === row.text, "text changed");
            check(target.location.row.kind === row.kind, "kind changed");
          }
        }
      }
    }));
});

/** Git's start for a hunk side: its first line, or the line before when empty. */
const gitStart = (line: number, count: number) => (count ? line : line - 1);

/**
 * A one-file patch as git writes it: an added file (one all-added hunk), a
 * deleted file (one all-removed hunk), or random hunks, each a random mix
 * of row kinds (some only added or only removed).
 */
function drawFilePatch(tc: hegel.TestCase): FilePatch {
  const shape = tc.draw(
    gs.sampledFrom(["modified", "added", "deleted"] as const)
  );
  if (shape !== "modified") {
    const size = tc.draw(gs.integers({ minValue: 1, maxValue: 12 }));
    const kind = shape === "added" ? "+" : "-";
    const lines = Array.from({ length: size }, (_, i) => `${kind}line ${i}`);
    return parsePatch(
      [
        "diff --git a/f b/f",
        shape === "added" ? "new file mode 100644" : "deleted file mode 100644",
        shape === "added" ? "--- /dev/null" : "--- a/f",
        shape === "added" ? "+++ b/f" : "+++ /dev/null",
        shape === "added" ? `@@ -0,0 +1,${size} @@` : `@@ -1,${size} +0,0 @@`,
        ...lines,
        "",
      ].join("\n")
    )[0];
  }
  const kinds = [" ", "+", "-"] as const;
  let oldLine = 1;
  let newLine = 1;
  const hunks: string[] = [];
  const count = tc.draw(gs.integers({ minValue: 1, maxValue: 3 }));
  for (let hunk = 0; hunk < count; hunk += 1) {
    // A gap of unchanged lines between hunks.
    const gap = tc.draw(gs.integers({ minValue: 0, maxValue: 5 }));
    oldLine += gap;
    newLine += gap;
    const only = tc.draw(gs.sampledFrom(["mixed", "+", "-"] as const));
    const rows = tc.draw(
      gs.arrays(gs.sampledFrom(only === "mixed" ? kinds : [only]), {
        minSize: 1,
        maxSize: 12,
      })
    );
    const oldCount = rows.filter((kind) => kind !== "+").length;
    const newCount = rows.filter((kind) => kind !== "-").length;
    hunks.push(
      `@@ -${gitStart(oldLine, oldCount)},${oldCount} +${gitStart(newLine, newCount)},${newCount} @@`,
      ...rows.map((kind, index) => `${kind}line ${hunk}.${index}`)
    );
    oldLine += oldCount;
    newLine += newCount;
  }
  return parsePatch(
    ["diff --git a/f b/f", "--- a/f", "+++ b/f", ...hunks, ""].join("\n")
  )[0];
}

/**
 * The `@@` header git writes for `rows`, a run of `hunk`'s rows from row
 * `from`, worked out from the hunk's own header and rows: a side's start is
 * its first line, or when the run has none, the line before the run.
 */
function gitHeader(
  hunk: FilePatch["hunks"][number],
  from: number,
  count: number
) {
  const header = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(
    hunk.header
  )!;
  const rows = hunk.rows.slice(from, from + count);
  const side = (lineOf: "oldLine" | "newLine", start: number, size: number) => {
    const lines = rows.flatMap((row) =>
      row[lineOf] === null ? [] : [row[lineOf]]
    );
    if (lines.length) return `${lines[0]},${lines.length}`;
    const earlier = hunk.rows
      .slice(0, from)
      .flatMap((row) => (row[lineOf] === null ? [] : [row[lineOf]]));
    // Before the run: the hunk's last line before it, else the line before
    // the hunk (its header's start, less one unless that side is empty).
    const before = earlier.length
      ? earlier[earlier.length - 1]
      : size
        ? start - 1
        : start;
    return `${before},0`;
  };
  return `@@ -${side("oldLine", Number(header[1]), Number(header[2] ?? 1))} +${side("newLine", Number(header[3]), Number(header[4] ?? 1))} @@`;
}

describe("a span's chunk", () => {
  test("is the span's rows and up to `context` rows of its hunk on each side", () =>
    hegel.test((tc) => {
      const file = drawFilePatch(tc);
      const side = tc.draw(gs.sampledFrom(["old", "new"] as const));
      const lines = file.hunks.flatMap((hunk) =>
        hunk.rows.flatMap((row) => {
          const line = rowLine(row, side);
          return line === null ? [] : [line];
        })
      );
      if (lines.length === 0) return;
      const a = tc.draw(gs.sampledFrom(lines));
      const b = tc.draw(gs.sampledFrom(lines));
      const span = { side, startLine: Math.min(a, b), endLine: Math.max(a, b) };
      const context = tc.draw(gs.integers({ minValue: 0, maxValue: 5 }));
      const chunk = spanChunk(file, span, context);
      const start = findRow(file, side, span.startLine)!;
      const end = findRow(file, side, span.endLine)!;
      if (start.hunkIndex !== end.hunkIndex) {
        check(chunk === null, "a span across hunks has no chunk");
        return;
      }
      check(chunk !== null, "a span in one hunk has a chunk");
      const rows = start.hunk.rows;
      const from = rows.indexOf(chunk!.rows[0]);
      // One contiguous run of the hunk's own rows.
      check(
        chunk!.rows.every((row, index) => rows[from + index] === row),
        "not a run of the hunk"
      );
      check(chunk!.rows[chunk!.first] === start.row, "first is not the start");
      check(chunk!.rows[chunk!.last] === end.row, "last is not the end");
      check(
        chunk!.first === Math.min(context, start.rowIndex),
        "wrong rows before"
      );
      check(
        chunk!.rows.length - 1 - chunk!.last ===
          Math.min(context, rows.length - 1 - end.rowIndex),
        "wrong rows after"
      );
    }));

  test("round-trips through its one-hunk patch, rows and line numbers intact", () =>
    hegel.test((tc) => {
      const file = drawFilePatch(tc);
      const hunk = tc.draw(
        gs.integers({ minValue: 0, maxValue: file.hunks.length - 1 })
      );
      const { rows } = file.hunks[hunk];
      const a = tc.draw(
        gs.integers({ minValue: 0, maxValue: rows.length - 1 })
      );
      const b = tc.draw(
        gs.integers({ minValue: 0, maxValue: rows.length - 1 })
      );
      // A span on the side both its ends have a line on, if any.
      const ends = [rows[Math.min(a, b)], rows[Math.max(a, b)]];
      const side = (["new", "old"] as const).find((candidate) =>
        ends.every((row) => rowLine(row, candidate) !== null)
      );
      if (!side) return;
      const context = tc.draw(gs.integers({ minValue: 0, maxValue: 5 }));
      const chunk = spanChunk(
        file,
        {
          side,
          startLine: rowLine(ends[0], side)!,
          endLine: rowLine(ends[1], side)!,
        },
        context
      )!;
      const patch = chunkPatch(file, chunk);
      const fileHunk = file.hunks[hunk];
      check(
        patch.split("\n")[3] ===
          gitHeader(
            fileHunk,
            fileHunk.rows.indexOf(chunk.rows[0]),
            chunk.rows.length
          ),
        `not git's header: ${patch.split("\n")[3]}`
      );
      const parsed = parsePatch(patch);
      check(parsed.length === 1, "not one file");
      check(canonicalPath(parsed[0]) === canonicalPath(file), "path changed");
      check(parsed[0].hunks.length === 1, "not one hunk");
      const strip = (row: (typeof rows)[number]) => [
        row.kind,
        row.text,
        row.oldLine,
        row.newLine,
      ];
      check(
        JSON.stringify(parsed[0].hunks[0].rows.map(strip)) ===
          JSON.stringify(chunk.rows.map(strip)),
        "rows or line numbers changed"
      );
    }));
});

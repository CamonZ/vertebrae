import { describe, test } from "vitest";
import * as hegel from "@hegeldev/hegel";
import {
  canonicalPath,
  parsePatch,
  projectToolRowToWorktree,
  projectWorktreeRowToToolCall,
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

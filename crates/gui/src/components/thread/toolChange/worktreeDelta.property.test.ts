import { describe, test } from "vitest";
import * as hegel from "@hegeldev/hegel";
import * as gs from "@hegeldev/hegel/generators";
import { countPatchLines, parseWorktreeDelta } from "./worktreeDelta";

const STATUSES = ["added", "modified", "deleted", "renamed"] as const;
const MARKERS = [
  "binary",
  "too_large",
  "baseline_unavailable",
  "patch_limit",
  "unreadable",
] as const;

function check(condition: boolean, message: string): void {
  if (!condition) throw new Error(message);
}

const filePath = gs.text({ minSize: 1, maxSize: 12 });

const file = gs.record({
  path: filePath,
  status: gs.sampledFrom(STATUSES),
  marker: gs.optional(gs.sampledFrom(MARKERS)),
});

/** A diff body with a known number of added and removed lines. */
function hunk(additions: number, deletions: number): string {
  const lines = ["@@ -1 +1 @@"];
  for (let i = 0; i < deletions; i++) lines.push(`-old ${i}`);
  for (let i = 0; i < additions; i++) lines.push(`+new ${i}`);
  return lines.join("\n");
}

describe("parseWorktreeDelta", () => {
  test("never throws on arbitrary JSON-like values", () =>
    hegel.test((tc) => {
      const value = tc.draw(
        gs.oneOf<unknown>(
          gs.integers(),
          gs.text(),
          gs.booleans(),
          gs.just(null),
          gs.arrays(gs.text()),
          gs.record({ files: gs.arrays(gs.text()), patch: gs.integers() }),
          gs.record({
            files: gs.arrays(gs.record({ path: gs.integers() })),
            patch: gs.text(),
          })
        )
      );
      parseWorktreeDelta(value);
    }));

  test("accepts every well-formed payload and keeps its files in order", () =>
    hegel.test((tc) => {
      const files = tc.draw(gs.arrays(file, { minSize: 1, maxSize: 6 }));
      const patch = tc.draw(gs.text({ maxSize: 40 }));
      const delta = parseWorktreeDelta({
        patch,
        files: files.map((f) => ({
          path: f.path,
          status: f.status,
          ...(f.marker ? { marker: { reason: f.marker } } : {}),
        })),
        aggregate: false,
        overlapping: false,
      });
      check(delta !== null, "well-formed payload was rejected");
      check(
        JSON.stringify(delta!.files.map((f) => f.path)) ===
          JSON.stringify(files.map((f) => f.path)),
        "file order changed"
      );
      for (const f of delta!.files) {
        check(
          f.marker === undefined ||
            (f.additions === undefined && f.deletions === undefined),
          "a marker file carried counts"
        );
      }
    }));

  test("one malformed file rejects the whole payload", () =>
    hegel.test((tc) => {
      const files = tc.draw(gs.arrays(file, { minSize: 1, maxSize: 6 }));
      const bad = tc.draw(
        gs.integers({ minValue: 0, maxValue: files.length - 1 })
      );
      const entries: unknown[] = files.map((f) => ({
        path: f.path,
        status: f.status,
      }));
      entries[bad] = { path: files[bad].path, status: "not-a-status" };
      check(
        parseWorktreeDelta({ patch: "", files: entries }) === null,
        "malformed entry was accepted"
      );
    }));
});

describe("countPatchLines", () => {
  test("counts exactly the added and removed hunk lines of each file", () =>
    hegel.test((tc) => {
      const specs = tc.draw(
        gs.arrays(
          gs.record({
            additions: gs.integers({ minValue: 0, maxValue: 8 }),
            deletions: gs.integers({ minValue: 0, maxValue: 8 }),
          }),
          { maxSize: 5 }
        )
      );
      const patch = specs
        .map(
          (s, i) =>
            `diff --git a/f${i}.txt b/f${i}.txt\n--- a/f${i}.txt\n+++ b/f${i}.txt\n${hunk(s.additions, s.deletions)}`
        )
        .join("\n");
      const counts = countPatchLines(patch);
      specs.forEach((s, i) => {
        const got = counts.get(`f${i}.txt`);
        check(
          got !== undefined &&
            got.additions === s.additions &&
            got.deletions === s.deletions,
          `file ${i}: expected +${s.additions} -${s.deletions}`
        );
      });
    }));
});

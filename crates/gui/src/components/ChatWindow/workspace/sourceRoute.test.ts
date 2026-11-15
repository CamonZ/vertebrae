import { describe, expect, it } from "vitest";
import { parseDiffFromFile } from "@pierre/diffs";
import type { WorktreeChange } from "../../../bindings";
import { routeSource } from "./sourceRoute";

const lines = (count: number) =>
  Array.from({ length: count }, (_, index) => `l${index + 1}`);
const text = (rows: string[]) => rows.join("\n") + "\n";

function change(
  path: string,
  before: string[] | null,
  after: string[] | null,
  extra: Partial<WorktreeChange> = {}
) {
  const file = {
    path,
    old_path: null,
    status: before == null ? "added" : after == null ? "deleted" : "modified",
    marker: null,
    totals: { additions: 0, deletions: 0, binary_files: 0 },
    patch: "",
    ...extra,
  } as WorktreeChange;
  const diff = parseDiffFromFile(
    before == null ? null : { name: path, contents: text(before) },
    after == null ? null : { name: path, contents: text(after) }
  );
  return { file, parsed: { files: [diff] } };
}

// Old 1..30; new replaces old 10 with two lines and deletes old 20.
const BEFORE = lines(30);
const AFTER = [
  ...BEFORE.slice(0, 9),
  "a",
  "b",
  ...BEFORE.slice(10, 19),
  ...BEFORE.slice(20),
];
const modified = change("f.ts", BEFORE, AFTER);
const route = (
  target: Parameters<typeof routeSource>[0],
  entries = [modified]
) =>
  routeSource(
    target,
    entries.map((entry) => entry.file),
    entries.map((entry) => entry.parsed)
  );

describe("routeSource", () => {
  it("opens a range touching changed lines as the diff", () => {
    expect(route({ path: "f.ts", line: 8, endLine: 10, nonce: 1 })).toEqual({
      view: "diff",
      target: { path: "f.ts", line: 8, endLine: 10, nonce: 1 },
    });
    expect(route({ path: "f.ts", line: 10, side: "old", nonce: 2 }).view).toBe(
      "diff"
    );
  });

  it("treats a range spanning a pure deletion as changed", () => {
    // Old 20 is deleted between new 20 and 21.
    expect(route({ path: "f.ts", line: 20, endLine: 21, nonce: 1 }).view).toBe(
      "diff"
    );
    expect(route({ path: "f.ts", line: 22, nonce: 1 }).view).toBe("file");
  });

  it("opens an unchanged range of a changed file as the full file", () => {
    expect(route({ path: "f.ts", line: 3, endLine: 5, nonce: 4 })).toEqual({
      view: "file",
      path: "f.ts",
      reveal: { path: "f.ts", line: 3, endLine: 5, nonce: 4 },
    });
  });

  it("renumbers unchanged old-side lines into the working file", () => {
    // +1 after the replacement, then −1 after the deletion.
    expect(
      route({ path: "f.ts", line: 15, endLine: 16, side: "old", nonce: 1 })
    ).toMatchObject({ reveal: { line: 16, endLine: 17 } });
    expect(
      route({ path: "f.ts", line: 25, side: "old", nonce: 1 })
    ).toMatchObject({ reveal: { line: 25, endLine: 25 } });
  });

  it("opens a file without changes in full, with or without lines", () => {
    expect(route({ path: "g.ts", line: 2, nonce: 1 }, [])).toEqual({
      view: "file",
      path: "g.ts",
      reveal: { path: "g.ts", line: 2, endLine: 2, nonce: 1 },
    });
    expect(route({ path: "g.ts", nonce: 1 }, [])).toEqual({
      view: "file",
      path: "g.ts",
      reveal: null,
    });
  });

  it("keeps whole-file, added, deleted and textless changes in the diff", () => {
    expect(route({ path: "f.ts", nonce: 1 }).view).toBe("diff");
    const added = change("new.ts", null, lines(3));
    expect(route({ path: "new.ts", line: 1, nonce: 1 }, [added]).view).toBe(
      "diff"
    );
    const deleted = change("old.ts", lines(3), null);
    expect(
      route({ path: "old.ts", line: 1, side: "old", nonce: 1 }, [deleted]).view
    ).toBe("diff");
    const binary = change("bin.dat", lines(1), lines(1), {
      marker: "binary",
    } as Partial<WorktreeChange>);
    expect(route({ path: "bin.dat", line: 1, nonce: 1 }, [binary]).view).toBe(
      "diff"
    );
  });

  it("follows an old-side reference through a rename", () => {
    const renamed = change("next.ts", BEFORE, AFTER, {
      old_path: "prev.ts",
      status: "renamed",
    } as Partial<WorktreeChange>);
    expect(
      route({ path: "prev.ts", line: 3, side: "old", nonce: 1 }, [renamed])
    ).toMatchObject({ view: "file", path: "next.ts" });
    expect(
      route({ path: "prev.ts", line: 10, side: "old", nonce: 1 }, [renamed])
    ).toMatchObject({ view: "diff", target: { path: "next.ts" } });
  });
});

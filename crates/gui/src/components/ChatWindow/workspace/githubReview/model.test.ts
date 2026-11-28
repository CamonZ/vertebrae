import { describe, expect, it } from "vitest";
import {
  buildReviewModel,
  driftExplanation,
  hunksShow,
  lineLabel,
  mappingRequest,
  markerKey,
  markerLabel,
} from "./model";
import { anchored, at, outdated, reviewThread } from "./fixture";

describe("buildReviewModel", () => {
  it("stacks threads on one line into one marker and keeps drift per thread", () => {
    const threads = [
      reviewThread("t1", { author: "alice" }),
      reviewThread("t2", { author: "bob", resolved: true }),
      reviewThread("t3", { line: 20, originalLine: 18 }),
    ];
    const model = buildReviewModel(
      7,
      threads,
      [
        at("t1", anchored(13)),
        at("t2", anchored(13)),
        at("t3", anchored(22, 20)),
      ],
      false
    );
    const markers = model.markersByPath.get("src/lib.rs") ?? [];
    expect(
      markers.map((marker) => [marker.line, marker.threads.length])
    ).toEqual([
      [13, 2],
      [22, 1],
    ]);
    const stacked = model.markerByKey.get(
      markerKey("src/lib.rs", "additions", 13)
    )!;
    expect(stacked.threads.map(({ drift }) => drift.kind)).toEqual([
      "current",
      "current",
    ]);
    expect(markerLabel(stacked)).toBe(
      "2 GitHub threads from alice, bob on line 13, 1 open, 1 resolved"
    );
    const moved = model.byThread.get("t3")!;
    expect(moved.kind === "line" && moved.drift).toEqual({
      kind: "moved",
      delta: 2,
    });
    expect(moved.kind === "line" && driftExplanation(moved)).toBe(
      "Published on line 20; your local edits moved it 2 lines down. GitHub re-anchors after you push."
    );
    expect(model.openCount).toBe(2);
  });

  it("keeps an edited line at its published anchor with the published code", () => {
    const published = [{ number: 13, text: "let total = 1;", focus: true }];
    const model = buildReviewModel(
      7,
      [reviewThread("t1")],
      [
        at("t1", {
          kind: "edited",
          startLine: 13,
          line: 13,
          published,
          editedLines: [13],
          publishedCommit: "1".repeat(40),
        }),
      ],
      false
    );
    const placed = model.byThread.get("t1")!;
    expect(placed).toMatchObject({
      kind: "line",
      line: 13,
      publishedLine: 13,
      drift: { kind: "edited", lines: [13], commit: "1".repeat(40) },
      published,
    });
    expect(placed.kind === "line" && driftExplanation(placed)).toBe(
      "You edited the commented line locally; reviewers still see line 13 as published."
    );
    const marker = model.markerByKey.get(
      markerKey("src/lib.rs", "additions", 13)
    )!;
    expect(markerLabel(marker)).toContain("commented line edited locally");
  });

  it.each([
    [
      [546],
      "You edited line 546 of the commented lines 541–549 locally; reviewers still see them as published.",
    ],
    [
      [543, 544, 545, 548],
      "You edited lines 543–545 and 548 of the commented lines 541–549 locally; reviewers still see them as published.",
    ],
    [
      [],
      "You added lines inside the commented lines 541–549 locally; reviewers still see them as published.",
    ],
  ])(
    "names the lines a local edit changed in a commented range: %j",
    (editedLines, note) => {
      const model = buildReviewModel(
        7,
        [reviewThread("t1")],
        [
          at("t1", {
            kind: "edited",
            startLine: 541,
            line: 549,
            published: [],
            editedLines,
            publishedCommit: "1".repeat(40),
          }),
        ],
        false
      );
      const placed = model.byThread.get("t1")!;
      expect(placed.kind === "line" && driftExplanation(placed)).toBe(note);
    }
  );

  it("lists outdated, file-level and undrawable threads for the rail only", () => {
    const threads = [
      reviewThread("old", { outdated: true, line: null, originalLine: 9 }),
      reviewThread("file", { fileLevel: true, line: null, path: "README.md" }),
      reviewThread("far", { line: 90, originalLine: 90 }),
      reviewThread("near", { side: "LEFT", line: 4, originalLine: 4 }),
    ];
    const model = buildReviewModel(
      7,
      threads,
      [
        at("old", outdated(9)),
        at("file", { kind: "file_level" }),
        at("far", anchored(90)),
        at("near", anchored(4)),
      ],
      true,
      (_path, side, line) => side === "deletions" || line < 50
    );
    expect([...model.markerByKey.values()].map((marker) => marker.key)).toEqual(
      [markerKey("src/lib.rs", "deletions", 4)]
    );
    expect(
      model.outdatedByPath.get("src/lib.rs")?.map(({ thread }) => thread.id)
    ).toEqual(["old"]);
    expect(model.byThread.get("far")).toMatchObject({
      kind: "line",
      inDiff: false,
    });
    // Files in path order; threads in line order, outdated at their old line.
    expect(
      model.files.map((file) => [
        file.path,
        file.threads.map(({ thread }) => thread.id),
      ])
    ).toEqual([
      ["README.md", ["file"]],
      ["src/lib.rs", ["near", "old", "far"]],
    ]);
    expect(lineLabel(model.byThread.get("old")!)).toBe("outdated · was line 9");
    expect(model.truncated).toBe(true);
  });

  it("leaves out threads that are not placed yet", () => {
    const model = buildReviewModel(7, [reviewThread("t1")], [], false);
    expect(model.byThread.size).toBe(0);
    expect(model.files).toEqual([]);
  });
});

describe("lineLabel and drift", () => {
  it("labels multi-line anchors from the placement's start line", () => {
    const model = buildReviewModel(
      7,
      [
        reviewThread("span", { startLine: 11, line: 13 }),
        reviewThread("old", {
          outdated: true,
          line: null,
          originalStartLine: 7,
          originalLine: 9,
        }),
      ],
      [
        at("span", anchored(15, 13, 12)),
        at("old", {
          kind: "outdated",
          originalStartLine: 7,
          originalLine: 9,
          original: [],
          originalCommit: null,
        }),
      ],
      false
    );
    expect(lineLabel(model.byThread.get("span")!)).toBe("lines 12–15");
    expect(lineLabel(model.byThread.get("old")!)).toBe(
      "outdated · was lines 7–9"
    );
  });

  it("blames the comparison's base, not local edits, on the old side", () => {
    const model = buildReviewModel(
      7,
      [reviewThread("left", { side: "LEFT", line: 4, originalLine: 4 })],
      [at("left", anchored(54, 4))],
      false
    );
    const placed = model.byThread.get("left")!;
    expect(placed.kind === "line" && driftExplanation(placed)).toBe(
      "Published on line 4 of the PR's base; this comparison's base has it 50 lines down."
    );
    // The marker's accessible name says the same.
    expect(markerLabel([...model.markerByKey.values()][0])).toContain(
      "anchor moved in this comparison's base"
    );
  });

  it("keeps an unplaceable thread in the rail, saying why", () => {
    const model = buildReviewModel(
      7,
      [reviewThread("bad")],
      [at("bad", { kind: "unplaceable", reason: "invalid_anchor" })],
      false
    );
    expect(model.byThread.get("bad")).toMatchObject({
      kind: "unplaceable",
      reason: "invalid_anchor",
    });
    expect(model.markerByKey.size).toBe(0);
    expect(lineLabel(model.byThread.get("bad")!)).toBe("not placeable here");
  });
});

describe("mappingRequest", () => {
  it("names the working tree as no target and the comparison base", () => {
    const comparison = {
      base_commit: "b".repeat(40),
      selected_base_commit: "b".repeat(40),
      target_commit: "c".repeat(40),
      working_tree: true,
      merge_base: true,
    };
    const thread = reviewThread("t1", { startSide: "LEFT", startLine: 11 });
    const request = mappingRequest("h", "m", comparison, [thread]);
    expect(request).toEqual({
      headOid: "h",
      baseOid: "m",
      shownTarget: null,
      shownBase: "b".repeat(40),
      // The whole anchor travels: no field can be dropped on the way.
      threads: [{ threadId: "t1", anchor: thread.anchor }],
    });
    expect(
      mappingRequest("h", "m", { ...comparison, working_tree: false }, [])
        .shownTarget
    ).toBe("c".repeat(40));
  });
});

describe("hunksShow", () => {
  it("counts rows of each side's hunk span only", () => {
    const hunks = [
      {
        additionStart: 10,
        additionCount: 5,
        deletionStart: 10,
        deletionCount: 3,
      },
    ];
    expect(hunksShow(hunks, "additions", 14)).toBe(true);
    expect(hunksShow(hunks, "additions", 15)).toBe(false);
    expect(hunksShow(hunks, "deletions", 12)).toBe(true);
    expect(hunksShow(hunks, "deletions", 13)).toBe(false);
  });
});

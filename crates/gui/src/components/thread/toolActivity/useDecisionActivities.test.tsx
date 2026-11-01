import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, expect, it, vi } from "vitest";
import * as hegel from "@hegeldev/hegel";
import * as gs from "@hegeldev/hegel/generators";
import { commands } from "../../../bindings";
import {
  applyDecisions,
  decisionSources,
  useDecisionActivities,
} from "./useDecisionActivities";
import type { ActivityAnalysis } from "./types";

vi.mock("../../../bindings", () => ({
  commands: { classifyToolOperations: vi.fn() },
}));
const classify = vi.mocked(commands.classifyToolOperations);
const row = (source: string, eligible = true): ActivityAnalysis => ({
  operations: [
    {
      activities: [],
      source,
      relationships: ["on success"],
      decisionEligible: eligible,
      unresolved: "Unsupported executable",
    },
  ],
});
beforeEach(() => {
  classify.mockReset();
});

it("never overwrites deterministic classification or changes source, targets, observations, and uncertainty", () =>
  hegel.test((tc) => {
    const source = tc.draw(gs.text({ maxSize: 50 }));
    const target = tc.draw(gs.text({ maxSize: 50 }));
    const labels = tc.draw(
      gs.arrays(
        gs.sampledFrom([
          "checks",
          "file edits",
          "source inspection",
          "task management",
          "coordination",
          "visual inspection",
          "UI interaction",
          "runtime inspection",
          "made-up",
        ]),
        { maxSize: 20 }
      )
    );
    const accepted = [
      ...new Set(labels.filter((label) => label !== "made-up")),
    ];
    const input: ActivityAnalysis[] = [
      {
        operations: [
          { ...row(source).operations[0], targets: [target] },
          {
            ...row(source).operations[0],
            activities: ["checks"],
            decisionEligible: false,
          },
        ],
      },
    ];
    const snapshot = JSON.stringify(input);
    const result = applyDecisions(input, {
      [source]: labels,
    });
    expect(JSON.stringify(input)).toBe(snapshot);
    expect(result[0].operations).toEqual([
      {
        ...input[0].operations[0],
        activities: accepted,
        ...(accepted.length ? { inferredActivities: accepted } : {}),
      },
      input[0].operations[1],
    ]);
  }));

it("bounds optional work and excludes opaque source and known activities", () => {
  const input = [
    row("opaque", false),
    row("x".repeat(4097)),
    {
      operations: [
        {
          source: "git status",
          activities: ["Git inspection"],
          relationships: [],
        },
      ],
    },
    ...Array.from({ length: 30 }, (_, i) => row(`unknown-${i}`)),
  ];
  expect(decisionSources(input)).toEqual(
    Array.from({ length: 16 }, (_, i) => `unknown-${i}`)
  );
  expect(
    applyDecisions([row("toString")], {})[0].operations[0].activities[0]
  ).toBeUndefined();
});

it("does no inference for collapsed groups or traces without a chat scope", async () => {
  const view = renderHook(
    ({ open, id }) => useDecisionActivities([row("mystery")], id, open),
    { initialProps: { open: false, id: "a" as string | null } }
  );
  view.rerender({ open: true, id: null });
  await act(async () => {});
  expect(classify).not.toHaveBeenCalled();
});

it("sends one bounded request and leaves scheduling and caching to the backend", async () => {
  classify.mockResolvedValue({
    status: "ok",
    data: Array.from({ length: 8 }, () => ["checks", "file edits"]),
  });
  const rows = Array.from({ length: 8 }, (_, i) => row(`command-${i}`));
  const view = renderHook(
    ({ open }) => useDecisionActivities(rows, "a", open),
    { initialProps: { open: true } }
  );
  await waitFor(() =>
    expect(view.result.current[0].operations[0].activities).toEqual([
      "checks",
      "file edits",
    ])
  );
  expect(classify).toHaveBeenCalledExactlyOnceWith(
    rows.map((r) => r.operations[0].source)
  );
  expect(view.result.current[0].operations).toHaveLength(1);
  view.rerender({ open: false });
  view.rerender({ open: true });
  await waitFor(() => expect(classify).toHaveBeenCalledTimes(2));
});

it("enriches partly understood scripts without duplicating commands or discarding syntax evidence", () => {
  const input = row("python3 script.py");
  input.operations[0].activities = ["source inspection"];
  input.operations[0].targets = ["input.txt"];
  const result = applyDecisions([input], {
    "python3 script.py": ["source inspection", "file edits", "checks"],
  });
  expect(result[0].operations).toHaveLength(1);
  expect(result[0].operations[0]).toEqual({
    ...input.operations[0],
    activities: ["source inspection", "file edits", "checks"],
    inferredActivities: ["file edits", "checks"],
  });
});

it("discards late answers from another session and leaves unavailable decisions unclassified", async () => {
  let finish!: (value: Awaited<ReturnType<typeof classify>>) => void;
  classify.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      })
  );
  classify.mockRejectedValue(new Error("offline"));
  const view = renderHook(
    ({ id }) => useDecisionActivities([row("mystery")], id, true),
    { initialProps: { id: "a" } }
  );
  view.rerender({ id: "b" });
  await act(async () => finish({ status: "ok", data: [["file edits"]] }));
  await waitFor(() => expect(classify).toHaveBeenCalledTimes(2));
  expect(view.result.current[0].operations[0].activities[0]).toBeUndefined();
  expect(view.result.current[0].operations[0].unresolved).toBe(
    "Unsupported executable"
  );
});

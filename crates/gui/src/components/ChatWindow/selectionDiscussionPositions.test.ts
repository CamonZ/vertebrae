import { expect, it } from "vitest";
import { SelectionDiscussionPositions } from "./selectionDiscussionPositions";

const position = (line: number) => ({
  status: "open" as const,
  startLine: line,
  line,
});

it("coalesces pending mappings and protects the latest position until its catalog event", () => {
  const writes = new SelectionDiscussionPositions();
  const first = writes.stage("id", position(1), position(3))!;
  expect(writes.stage("id", position(1), position(4))).toBeUndefined();
  expect(writes.stage("id", position(1), position(7))).toBeUndefined();
  const latest = writes.finish("id", position(1), first, true)!;
  expect(latest.position).toEqual(position(7));
  writes.finish("id", position(1), latest, true);
  writes.observe("id", position(3));
  expect(writes.preservesProjection("id")).toBe(true);
  writes.observe("id", position(7));
  expect(writes.preservesProjection("id")).toBe(false);
});

it("writes a queued reversal even when the catalog has not acknowledged the first write", () => {
  const writes = new SelectionDiscussionPositions();
  const first = writes.stage("id", position(1), position(3))!;
  writes.stage("id", position(1), position(1));
  const reversal = writes.finish("id", position(1), first, true)!;
  expect(reversal.position).toEqual(position(1));
  writes.observe("id", position(3));
  writes.observe("id", position(1));
  writes.finish("id", position(1), reversal, true);
  expect(writes.preservesProjection("id")).toBe(false);
});

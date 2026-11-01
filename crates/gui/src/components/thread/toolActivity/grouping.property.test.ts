import { expect, test } from "vitest";
import * as hegel from "@hegeldev/hegel";
import * as gs from "@hegeldev/hegel/generators";
import { activityLabel, activitySummary, groupToolMessages } from "./grouping";
import type { Message } from "../types";
import type { ActivityAnalysis } from "./types";

const kinds = [
  "tool",
  "user",
  "agent",
  "system",
  "spawn",
  "error",
  "wait",
  "activity",
] as const;
function message(kind: (typeof kinds)[number], index: number): Message {
  const evt = `event-${index}`;
  if (kind === "spawn")
    return {
      type: kind,
      evt,
      thread: {
        id: evt,
        turns: [
          {
            id: `${evt}-turn`,
            messages: [{ type: "tool", evt: `${evt}-child-tool` }],
          },
        ],
      },
    };
  if (kind === "activity")
    return {
      type: kind,
      evt,
      variant: "progress",
      label: "progress",
      text: "",
    };
  return { type: kind, evt };
}

test("grouping preserves identities, order, multiplicity and maximal tool runs", () =>
  hegel.test((tc) => {
    const input = tc
      .draw(gs.arrays(gs.sampledFrom(kinds), { maxSize: 80 }))
      .map(message);
    if (input.length && tc.draw(gs.booleans())) {
      // Repeated references must remain repeated, rather than being deduplicated.
      const duplicate =
        input[
          tc.draw(gs.integers({ minValue: 0, maxValue: input.length - 1 }))
        ];
      input.splice(
        tc.draw(gs.integers({ minValue: 0, maxValue: input.length })),
        0,
        duplicate
      );
    }
    const original = [...input];
    input.forEach(Object.freeze);
    const groups = groupToolMessages(input);
    const flattened = groups.flatMap((g) => (Array.isArray(g) ? g : [g]));
    expect(flattened).toHaveLength(input.length);
    flattened.forEach((m, i) => expect(m).toBe(original[i]));
    expect(input).toEqual(original);
    let cursor = 0;
    for (const group of groups) {
      if (Array.isArray(group)) {
        expect(group.length).toBeGreaterThan(0);
        expect(cursor === 0 || input[cursor - 1].type !== "tool").toBe(true);
        for (const m of group) {
          expect(m.type).toBe("tool");
          expect(m).toBe(input[cursor++]);
        }
        expect(cursor === input.length || input[cursor].type !== "tool").toBe(
          true
        );
      } else {
        expect(group.type).not.toBe("tool");
        expect(group).toBe(input[cursor++]);
      }
    }
    expect(cursor).toBe(input.length);
  }));

test("separately rendered conversation/agent segments keep their own tool groups", () =>
  hegel.test((tc) => {
    const sizes = tc.draw(
      gs.arrays(gs.integers({ minValue: 0, maxValue: 12 }), { maxSize: 12 })
    );
    let identity = 0;
    const segments = sizes.map((size) =>
      Array.from({ length: size }, () => message("tool", identity++))
    );
    const grouped = segments.map(groupToolMessages);
    grouped.forEach((groups, segment) => {
      expect(groups).toHaveLength(sizes[segment] ? 1 : 0);
      expect(groups.flat()).toEqual(segments[segment]);
      groups
        .flat()
        .forEach((m) => expect(segments[segment].includes(m)).toBe(true));
    });
  }));

test("compact activities are a bounded union, unaffected by duplicate calls", () =>
  hegel.test((tc) => {
    const vocabulary = [
      "file edits",
      "checks",
      "source inspection",
      "source search",
      "documentation",
      "Git inspection",
      "coordination",
      "web requests",
    ];
    const rows: ActivityAnalysis[] = tc
      .draw(
        gs.arrays(
          gs.arrays(
            gs.record({
              activity: gs.sampledFrom([...vocabulary, undefined]),
              unresolved: gs.booleans(),
            }),
            { maxSize: 12 }
          ),
          { maxSize: 15 }
        )
      )
      .map((ops) => ({
        operations: ops.map((o) => ({
          source: "request",
          relationships: [],
          activities: o.activity ? [o.activity] : [],
          unresolved: o.unresolved ? "unknown" : undefined,
        })),
      }));
    const before = JSON.stringify(rows);
    const union = new Set<string>();
    let unknown = false;
    for (const row of rows)
      for (const operation of row.operations) {
        if (operation.activities[0]) union.add(operation.activities[0]);
        if (operation.unresolved && !operation.activities.length)
          unknown = true;
      }
    if (unknown) union.add("other operations");
    const label = activityLabel(rows);
    expect(activitySummary(rows)).toEqual({
      labels: [...union].slice(0, 4),
      overflow: Math.max(0, union.size - 4),
    });
    const [head, overflow] = label.split(" +");
    const visible = head ? head.split(", ") : [];
    expect(visible).toEqual([...union].slice(0, 4));
    expect(overflow).toBe(
      union.size > 4 ? `${union.size - 4} more` : undefined
    );
    expect(activityLabel([...rows, ...rows])).toBe(label);
    expect(JSON.stringify(rows)).toBe(before);
  }));

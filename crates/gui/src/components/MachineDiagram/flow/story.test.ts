import { describe, expect, it } from "vitest";
import fixture from "./__fixtures__/inlineDiscussions.flow.yaml?raw";
import { compileFlowOrThrow, parseFlowSpec } from "./index";
import { storyActors } from "./story";

const parsed = parseFlowSpec(fixture);
if (!parsed.ok) throw new Error("invalid fixture");
const flow = compileFlowOrThrow(parsed.value);
const diagram = flow.arrangements.find((d) => d.arrangement === "after")!;

describe("Story activity windows", () => {
  it("uses caption windows rather than the next raw step; excludes end-boundary and absent parts", () => {
    const part = diagram.parts[0];
    const d = {
      ...diagram,
      beats: [
        { id: "caption", t: 1, caption: "First", attachments: [], changes: [] },
      ],
      beatWindows: { caption: [1, 5] as const },
      markers: [],
      parts: [
        {
          ...part,
          id: "continuation",
          steps: [{ ...part.steps[0], t: 4, end: 4.5 }],
        },
        {
          ...part,
          id: "spanning",
          steps: [{ ...part.steps[0], t: 0, end: 2 }],
        },
        { ...part, id: "ended", steps: [{ ...part.steps[0], t: 0, end: 1 }] },
        { ...part, id: "next", steps: [{ ...part.steps[0], t: 5, end: 6 }] },
        {
          ...part,
          id: "absent",
          presence: "absent" as const,
          steps: [{ ...part.steps[0], t: 2, end: 3 }],
        },
      ],
    };
    expect(
      storyActors(flow, d, 0)
        .filter((a) => a.key.startsWith("part:"))
        .map((a) => a.key)
    ).toEqual(["part:continuation", "part:spanning"]);
  });

  it("groups cards travelling across a caption boundary with their rail in both beats", () => {
    const rail = diagram.rails[0];
    const travel = diagram.travel.cards[0];
    const d = {
      ...diagram,
      beats: [
        { t: 1, caption: "Departure", attachments: [], changes: [] },
        { t: 3, caption: "Arrival", attachments: [], changes: [] },
      ],
      period: 6,
      parts: [],
      rails: [{ ...rail, presence: "live" as const }],
      markers: [
        { t: 4, kind: "arrival", label: "arrives", card: "q1", rail: rail.id },
      ],
      travel: {
        ...diagram.travel,
        cards: [
          { ...travel, id: "q1", legs: [{ ...travel.legs[0], t: 2, d: 2 }] },
        ],
      },
    };
    for (const i of [0, 1])
      expect(storyActors(flow, d, i).map((a) => a.key)).toEqual([
        `rail:${rail.id}`,
        "card:q1",
      ]);
  });
});

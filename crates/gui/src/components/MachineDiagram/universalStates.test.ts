/**
 * Universal states for every gallery part: the fixture holds each part's
 * scenario 0 and 1 notes, periods and stills, plus the pose time, scenario
 * and status line the gallery's statePose produced (cross-checked against
 * its #spec dump).
 */
import { describe, expect, it } from "vitest";
import data from "./__fixtures__/galleryUniversalStates.json";
import { stateLabel } from "./accessibility";
import type { StateRole } from "./palette";
import { stateAt, story, note, seal, type StatusNote } from "./timeline";
import {
  UNIVERSAL_STATES,
  lastStatusTime,
  outT,
  statePose,
  workT,
  type ScenarioTiming,
} from "./universalStates";

interface PartStates {
  name: string;
  job: string;
  scenarios: {
    name: string;
    period: number;
    still: number;
    notes: [number, string, StateRole][];
  }[];
  states: Record<string, { t: number; si: 0 | 1; status: [string, StateRole] }>;
}

const PARTS = data as unknown as PartStates[];

const timing = (s: PartStates["scenarios"][number]): ScenarioTiming => ({
  period: s.period,
  still: s.still,
  notes: s.notes as StatusNote[],
});

describe("statePose against the gallery", () => {
  it("covers all 59 parts", () => {
    expect(PARTS).toHaveLength(59);
  });

  it.each(PARTS.map((p) => [p.name, p] as const))("%s", (_, part) => {
    const scenarios = [
      timing(part.scenarios[0]),
      timing(part.scenarios[1]),
    ] as const;
    for (const state of UNIVERSAL_STATES) {
      const pose = statePose(scenarios, state);
      const e = part.states[state];
      expect(pose.t, `${part.name} ${state} time`).toBeCloseTo(e.t, 3);
      expect(pose.scenario, `${part.name} ${state} scenario`).toBe(e.si);
      // status line shown at that pose
      const notes = scenarios[pose.scenario].notes;
      const frame = stateAt(
        {
          period: scenarios[pose.scenario].period,
          cards: [],
          gates: [],
          notes,
        },
        pose.t,
        {
          pose: pose.pose,
        }
      );
      expect(
        [frame.status.current.text, frame.status.current.role],
        `${part.name} ${state} status`
      ).toEqual(e.status);
    }
  });
});

describe("pose rules", () => {
  const happy = (() => {
    const s = story(5);
    note(s, 0.6, "job arrives", "ink");
    note(s, 1.2, "working", "dim");
    note(s, 2.0, "done", "green");
    note(s, 2.2, "done · stored", "green");
    return seal(s);
  })();
  const failure = (() => {
    const s = story(5);
    note(s, 0.6, "job arrives", "ink");
    note(s, 1.8, "failed", "red");
    note(s, 1.9, "gave up", "red");
    return seal(s);
  })();
  const tHappy: ScenarioTiming = { ...happy, still: 1.5 };
  const tFail: ScenarioTiming = { ...failure, still: 1.5 };

  it("ok is the last green note + 0.3 s, capped before the next note", () => {
    expect(outT(tHappy, "green", 99)).toBeCloseTo(2.5, 9);
    const extra: StatusNote = [2.3, "x", "dim"];
    const notes = [...happy.notes, extra].sort((a, b) => a[0] - b[0]);
    const capped: ScenarioTiming = { ...tHappy, notes };
    expect(outT(capped, "green", 99)).toBeCloseTo(2.28, 9);
  });

  it("failed comes from scenario 1's last red note", () => {
    const pose = statePose([tHappy, tFail], "failed");
    expect(pose).toMatchObject({ state: "failed", scenario: 1, pose: "live" });
    expect(pose.t).toBeCloseTo(2.2, 9);
  });

  it("working sits just after the last in-progress note before the outcome", () => {
    expect(workT(tHappy)).toBeCloseTo(1.55, 9);
  });

  it("falls back to the last status, then the still, when no outcome colour exists", () => {
    const plain: ScenarioTiming = {
      period: 4,
      still: 1.7,
      notes: [
        [0, "idle", "dim"],
        [3.55, "idle", "dim"],
      ],
    };
    expect(lastStatusTime(plain, 1.7)).toBe(1.7);
    expect(statePose([plain, plain], "ok").t).toBe(1.7);
    expect(statePose([plain, plain], "failed").t).toBe(1.7);
    expect(statePose([plain, plain], "working").t).toBeCloseTo(0.85, 9);
  });

  it("idle and absent are still poses with no cards", () => {
    expect(statePose([tHappy, tFail], "idle")).toMatchObject({
      t: 0,
      pose: "idle",
      scenario: 0,
    });
    expect(statePose([tHappy, tFail], "absent")).toMatchObject({
      t: 0,
      pose: "absent",
      scenario: 0,
    });
  });

  it("names part, state and change in accessible text", () => {
    expect(
      stateLabel({ name: "worker", job: "runs one job" }, "ok", "unchanged")
    ).toBe("worker, ok, unchanged. runs one job.");
  });
});

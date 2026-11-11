/**
 * Parity with the catalogue gallery (vtb://artifact/9c0496e1-…): the expected
 * values were dumped from the gallery's own engine in headless Chrome
 * (cardPos, drawCard opacity/lean/tags, gates, note) every 0.1 s, at each
 * scenario's still and at the five universal-state pose times of its #spec.
 */
import { describe, expect, it } from "vitest";
import {
  GALLERY_FIXTURES,
  type GalleryPartFixture,
} from "./__fixtures__/galleryParts";
import parity from "./__fixtures__/galleryParity.json";
import { stateAt, type DiagramFrame } from "./timeline";
import {
  UNIVERSAL_STATES,
  statePose,
  type ScenarioTiming,
} from "./universalStates";

interface ExpectedFrame {
  t: number;
  fade: number;
  cards: {
    i: number;
    x: number;
    y: number;
    a: number;
    lean: number;
    role: string;
    tags: [string, number, number, number][];
  }[];
  gates: [number, boolean][];
  note: [string, string];
  prev: string | null;
}

interface ExpectedPart {
  sc: { name: string; frames: ExpectedFrame[] }[];
  pose: Record<string, { t: number; si: number; frame: ExpectedFrame | null }>;
}

const EXPECTED = parity as unknown as Record<string, ExpectedPart>;
const TOL = 2e-3;

function compare(actual: DiagramFrame, e: ExpectedFrame) {
  expect(actual.fade).toBeCloseTo(e.fade, 3);
  expect(actual.cards.map((c) => c.index)).toEqual(e.cards.map((c) => c.i));
  actual.cards.forEach((c, k) => {
    const x = e.cards[k];
    expect(Math.abs(c.x - x.x)).toBeLessThan(TOL);
    expect(Math.abs(c.y - x.y)).toBeLessThan(TOL);
    expect(Math.abs(c.alpha - x.a)).toBeLessThan(TOL);
    expect(Math.abs(c.angle - x.lean)).toBeLessThan(TOL);
    expect(c.role).toBe(x.role);
    expect(c.tags.map((tag) => tag.text)).toEqual(x.tags.map((tag) => tag[0]));
    c.tags.forEach((tag, j) => {
      expect(Math.abs(tag.y - x.tags[j][2])).toBeLessThan(TOL);
      expect(Math.abs(tag.alpha - x.tags[j][3])).toBeLessThan(TOL);
    });
  });
  expect(actual.gates.map((g) => Math.round(g.open * 1000) / 1000)).toEqual(
    e.gates.map(([open]) => Math.round(open * 1000) / 1000)
  );
  expect(actual.gates.map((g) => g.amber)).toEqual(
    e.gates.map(([, amber]) => amber)
  );
  expect([actual.status.current.text, actual.status.current.role]).toEqual(
    e.note
  );
  expect(actual.status.previous?.text ?? null).toBe(e.prev);
}

const timing = (f: GalleryPartFixture, i: number): ScenarioTiming => ({
  period: f.scenarios[i].timeline.period,
  notes: f.scenarios[i].timeline.notes,
  still: f.scenarios[i].still,
});

describe.each(Object.entries(GALLERY_FIXTURES))(
  "gallery parity: %s",
  (name, fixture) => {
    const expected = EXPECTED[name];
    const f = fixture as GalleryPartFixture;

    it("covers every gallery scenario", () => {
      expect(f.scenarios.map((s) => s.name)).toEqual(
        expected.sc.map((s) => s.name)
      );
    });

    it("matches the gallery frame by frame in every scenario", () => {
      expected.sc.forEach((sc, i) => {
        for (const e of sc.frames)
          compare(stateAt(f.scenarios[i].timeline, e.t), e);
      });
    });

    it("matches pose and status line at the universal-state times", () => {
      const scenarios = [timing(f, 0), timing(f, 1)] as const;
      for (const state of UNIVERSAL_STATES) {
        const pose = statePose(scenarios, state);
        const e = expected.pose[state];
        expect(pose.t).toBeCloseTo(e.t, 3);
        expect(pose.scenario).toBe(e.si);
        const frame = stateAt(f.scenarios[pose.scenario].timeline, pose.t, {
          pose: pose.pose,
        });
        if (e.frame) compare(frame, e.frame);
        else {
          expect(frame.cards).toEqual([]);
          expect(frame.status.current.text).toBe(
            state === "idle" ? "idle" : "absent · no instance"
          );
        }
      }
    });
  }
);

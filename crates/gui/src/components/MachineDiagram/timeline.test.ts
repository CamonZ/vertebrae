import { describe, expect, it } from "vitest";
import { workerFixture } from "./__fixtures__/galleryParts";
import {
  IDLE_RETURN,
  beatOutcomeTime,
  card,
  cardPosition,
  dot,
  note,
  seal,
  stateAt,
  statusAt,
  stay,
  story,
} from "./timeline";

const worker = workerFixture.scenarios[0].timeline;

describe("authoring", () => {
  it("seal sorts notes and returns to idle 0.45 s before the loop ends", () => {
    const s = story(4);
    note(s, 2, "b", "ink");
    note(s, 1, "a", "dim");
    const tl = seal(s);
    expect(tl.notes).toEqual([
      [0, "idle", "dim"],
      [1, "a", "dim"],
      [2, "b", "ink"],
      [4 - IDLE_RETURN, "idle", "dim"],
    ]);
  });

  it("cards default to a 0.64 aspect, tags 22 px above, and dots die after their leg", () => {
    const c = card(
      28,
      "ink",
      [
        [
          [
            [0, 0],
            [10, 0],
          ],
          0,
          1,
        ],
      ],
      0,
      1,
      { tags: [["x", 0, 1]] }
    );
    expect(c.h).toBeCloseTo(17.92, 9);
    expect(c.tags[0].dy).toBe(-22);
    const d = dot(
      [
        [0, 0],
        [10, 0],
      ],
      1,
      0.5
    );
    expect(d).toMatchObject({ dot: true, w: 14, born: 1, dies: 1.55 });
  });

  it("follows the active leg; a stay leg holds the card", () => {
    const c = card(
      28,
      "ink",
      [
        [
          [
            [0, 0],
            [100, 0],
          ],
          0,
          0.5,
        ],
        stay(100, 50, 2),
      ],
      0,
      3
    );
    expect(cardPosition(c, 1.5)[0]).toBeCloseTo(100, 1);
    expect(cardPosition(c, 2.5)).toEqual([100, 50]);
  });
});

describe("stateAt", () => {
  it("is a pure function of t: same input, same frame; seeking backwards works", () => {
    const a = stateAt(worker, 1.3);
    stateAt(worker, 3.1);
    const b = stateAt(worker, 1.3);
    expect(b).toEqual(a);
    expect(JSON.stringify(stateAt(worker, 0.9))).toBe(
      JSON.stringify(stateAt(worker, 0.9))
    );
  });

  it("fades cards in the last 0.6 s of the loop", () => {
    const s = story(2);
    s.cards.push(card(28, "ink", [stay(10, 10, 0)], 0, 5));
    const tl = seal(s);
    expect(stateAt(tl, 1).cards[0].alpha).toBe(1);
    expect(stateAt(tl, 1.6).cards[0].alpha).toBeCloseTo(0.5, 9);
    expect(stateAt(tl, 1.9).cards).toEqual([]);
  });

  it("never smears hollow control cards", () => {
    const s = story(3);
    s.cards.push(
      card(
        28,
        "ink",
        [
          [
            [
              [0, 0],
              [300, 0],
            ],
            0.2,
            0.5,
          ],
        ],
        0.2,
        2,
        { hollow: true }
      )
    );
    const frame = stateAt(seal(s), 0.5);
    expect(frame.cards[0].hollow).toBe(true);
    expect(frame.cards[0].ghosts).toEqual([]);
  });

  it("turns smear off for still views", () => {
    expect(stateAt(worker, 0.8, { smear: false }).cards[0].ghosts).toEqual([]);
  });

  it("leans 38° at a lean time", () => {
    const s = story(3);
    s.cards.push(card(28, "ink", [stay(0, 0, 0)], 0, 3, { lean: [1] }));
    const tl = seal(s);
    expect(stateAt(tl, 1).cards[0].angle).toBeCloseTo(38, 9);
    expect(stateAt(tl, 0.5).cards[0].angle).toBe(0);
  });

  it.each([
    ["idle", "idle"],
    ["absent", "absent · no instance"],
    ["removed", "removed in this change"],
  ] as const)("the %s pose stands still with no cards", (pose, text) => {
    const frame = stateAt(worker, 1.3, { pose });
    expect(frame).toMatchObject({ t: 0, pose, cards: [] });
    expect(frame.status.current.text).toBe(text);
    expect(frame.gates.every((g) => g.open === 0)).toBe(true);
  });
});

describe("status line", () => {
  const notes = worker.notes;

  it("swaps: old text rises 16 px and fades in 0.1 s; new text rises from 14 px", () => {
    const start = statusAt(notes, 1.35);
    expect(start.previous).toMatchObject({
      text: "job arrives",
      dy: -0,
      alpha: 1,
    });
    expect(start.current).toMatchObject({
      text: "working · · ·",
      dy: 14,
      alpha: 0,
    });
    const out = statusAt(notes, 1.45);
    expect(out.previous?.dy).toBeCloseTo(-16, 9);
    expect(out.previous?.alpha).toBeCloseTo(0, 9);
    expect(statusAt(notes, 1.62)).toEqual({
      current: { text: "working · · ·", role: "dim", dy: 0, alpha: 1 },
      previous: null,
    });
  });

  it("shows the settled line when swap is off", () => {
    expect(statusAt(notes, 1.36, false).previous).toBeNull();
    expect(statusAt(notes, 1.36, false).current.dy).toBe(0);
  });
});

describe("reduced motion", () => {
  it("snaps to the outcome of the current beat", () => {
    // beat "working" runs 1.35 → 2.65
    expect(beatOutcomeTime(worker, 1.5)).toBeCloseTo(2.63, 9);
    expect(beatOutcomeTime(worker, 2.0)).toBeCloseTo(2.63, 9);
    // last beat is cut before the closing fade
    expect(beatOutcomeTime(worker, 3.0)).toBeCloseTo(worker.period - 0.62, 9);
  });

  it("renders without interpolation: no smear, no status swap, same frame across the beat", () => {
    const a = stateAt(worker, 1.4, { reducedMotion: true });
    const b = stateAt(worker, 2.4, { reducedMotion: true });
    expect(a).toEqual(b);
    expect(a.status.previous).toBeNull();
    expect(a.cards.every((c) => c.ghosts.length === 0)).toBe(true);
    expect(a.t).toBeCloseTo(2.63, 9);
  });
});

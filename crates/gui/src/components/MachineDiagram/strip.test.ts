/**
 * Strip test (VL-05/VL-06): consecutive 60 fps frames of the worker's job card
 * travelling 24 → 320 and crossing the in-gate at x = 210.
 */
import { describe, expect, it } from "vitest";
import { workerFixture } from "./__fixtures__/galleryParts";
import { stateAt, type CardFrame } from "./timeline";

const timeline = workerFixture.scenarios[0].timeline;
const LEG_START = 0.6;
const LEG_DURATION = 0.6;
const GATE_X = 210;
const frames = Array.from(
  { length: Math.round(1.2 * 60) },
  (_, i) => LEG_START + i / 60
);

const job = (t: number): CardFrame | undefined =>
  stateAt(timeline, t).cards.find((c) => c.index === 0);
const smearLength = (c: CardFrame) =>
  c.ghosts.length ? c.x - c.ghosts[0].x : 0;
const inGate = (t: number) => stateAt(timeline, t).gates[0];

describe("card crossing a gate", () => {
  it("smears longest early in the throw and the smear decays to nothing on arrival", () => {
    const strip = frames
      .filter((t) => t < LEG_START + LEG_DURATION)
      .map(job)
      .filter((c): c is CardFrame => c !== undefined)
      .map(smearLength);
    const longest = strip.indexOf(Math.max(...strip));
    expect(longest).toBeLessThan(strip.length / 2);
    for (let i = longest + 1; i < strip.length; i++)
      expect(strip[i]).toBeLessThanOrEqual(strip[i - 1] + 1e-9);
    // after arrival only the tiny overshoot remains (under 1 px of smear)
    expect(Math.abs(smearLength(job(LEG_START + 1.1)!))).toBeLessThan(1);
  });

  it("draws ten fading ghosts behind the card", () => {
    const c = job(0.8)!;
    expect(c.ghosts).toHaveLength(10);
    const alphas = c.ghosts.map((g) => g.alpha);
    expect([...alphas].sort((a, b) => a - b)).toEqual(alphas);
    expect(c.ghosts.every((g) => g.x < c.x)).toBe(true);
  });

  it("opens the gate only while the card is crossing it", () => {
    const open = frames.map((t) => inGate(t).open);
    const near = frames.map((t) => {
      // gate samples the card from 0.12 s before to 0.16 s after the frame
      let d = Infinity;
      for (let k = -3; k <= 4; k++) {
        const c = job(t + k * 0.04);
        if (c) d = Math.min(d, Math.abs(c.x - GATE_X));
      }
      return d;
    });
    open.forEach((o, i) => {
      if (near[i] >= 30) expect(o).toBe(0);
      if (near[i] <= 10) expect(o).toBe(1);
    });
    const openFrames = open
      .map((o, i) => (o > 0 ? i : -1))
      .filter((i) => i >= 0);
    expect(openFrames.length).toBeGreaterThan(0);
    // one contiguous opening: the pills close behind the card
    expect(openFrames[openFrames.length - 1] - openFrames[0] + 1).toBe(
      openFrames.length
    );
    expect(open[0]).toBe(0);
    expect(open[open.length - 1]).toBe(0);
  });

  it("parts the pills from 11 px to 24 px", () => {
    const widest = frames
      .map(inGate)
      .reduce((a, b) => (b.open > a.open ? b : a));
    expect(widest.offset).toBe(24);
    expect(inGate(LEG_START).offset).toBe(11);
  });
});

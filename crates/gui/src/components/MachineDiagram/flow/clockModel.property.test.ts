/**
 * Model-based tests of the flow player's clock (clockModel.ts). A Hegel state
 * machine applies random sequences of player actions — play, pause, beat and
 * frame steps, chapter jumps, speed changes, animation ticks and reduced-motion
 * switches — to generated timelines and to the compiled reference flows, and
 * checks every transition against the player's rules.
 */
import { test } from "vitest";
import * as hegel from "@hegeldev/hegel";
import * as gs from "@hegeldev/hegel/generators";
import burstOptions from "./__fixtures__/burstOptions.flow.yaml?raw";
import inlineDiscussions from "./__fixtures__/inlineDiscussions.flow.yaml?raw";
import mechanisms from "./__fixtures__/mechanisms.flow.yaml?raw";
import { beatIndex, type Timeline } from "../timeline";
import {
  FRAME,
  MAX_FRAME_DT,
  SPEEDS,
  beatOutcome,
  beatStart,
  clockStep,
  initialClock,
  nextSpeed,
  playEnd,
  retarget,
  shownBeat,
  shownTime,
  type ClockState,
} from "./clockModel";
import { compileFlowOrThrow, parseFlowSpec } from "./index";

const EPS = 1e-9;

function check(condition: boolean, message: string): void {
  if (!condition) throw new Error(message);
}

function compiled(source: string) {
  const parsed = parseFlowSpec(source);
  if (!parsed.ok) throw new Error("fixture does not parse");
  return compileFlowOrThrow(parsed.value);
}

const FIXTURES: readonly Timeline[] = [
  ...compiled(inlineDiscussions).arrangements.map((a) => a.travel),
  ...compiled(mechanisms).arrangements.map((a) => a.travel),
  ...compiled(burstOptions).arrangements.map((a) => a.travel),
];

/** A beats-only timeline: distinct beats at least 0.1 s apart, ending before the loop fade. */
const generatedTimeline = gs.composite<Timeline>((tc) => {
  const start = tc.draw(gs.floats({ minValue: 0, maxValue: 1.5 }));
  const gaps = tc.draw(
    gs.arrays(gs.floats({ minValue: 0.1, maxValue: 3 }), { maxSize: 8 })
  );
  const times = [start];
  for (const g of gaps) times.push(times[times.length - 1] + g);
  const tail = tc.draw(gs.floats({ minValue: 0.7, maxValue: 3 }));
  const withBeats = tc.draw(gs.booleans());
  // Compiled flows number each beat by the story beat it starts at, rising
  // with gaps where this arrangement leaves a story beat uncaptioned.
  const stories = tc.draw(gs.booleans());
  let story = tc.draw(gs.integers({ minValue: 0, maxValue: 2 }));
  const beats = times.map((t, i) => {
    const b = { t, caption: `beat ${i}`, ...(stories ? { story } : {}) };
    story += tc.draw(gs.integers({ minValue: 1, maxValue: 3 }));
    return b;
  });
  return {
    period: times[times.length - 1] + tail,
    cards: [],
    gates: [],
    notes: [[0, "idle", "dim"]],
    beats: withBeats ? beats : [],
  };
});

const timeline = gs.oneOf(gs.sampledFrom(FIXTURES), generatedTimeline);

const outcomes = (tl: Timeline) =>
  (tl.beats ?? []).map((_, i) => beatOutcome(tl, i));

/**
 * What a landing on beat `i` (opening, step, seek, a paused switch) draws:
 * the beat's start, so Play animates it; its outcome under reduced motion,
 * which only ever draws settled beats.
 */
const landing = (tl: Timeline, i: number, reduced: boolean) =>
  reduced ? beatOutcome(tl, i) : beatStart(tl, i);

/** Forward distance from `a` to `b` around a loop of `period`. */
const forward = (a: number, b: number, period: number) =>
  (((b - a) % period) + period) % period;

/** Distance between two points on a loop of `period`, either way round. */
const loopGap = (a: number, b: number, period: number) => {
  const d = forward(a, b, period);
  return Math.min(d, period - d);
};

/** Runs of `playThrough` that reached a beat's stop / the play-once end. */
const stopsReached = { beat: 0, end: 0 };

interface Machine {
  tl: Timeline;
  s: ClockState;
  reduced: boolean;
}

const n = (m: Machine) => m.tl.beats?.length ?? 0;
const shown = (m: Machine) => shownTime(m.tl, m.s, m.reduced);
const beat = (m: Machine) => shownBeat(m.tl, m.s, m.reduced);

function landedOnBeat(m: Machine, s: ClockState, want: number, what: string) {
  check(!s.playing, `${what} left the clock playing`);
  const at = shownTime(m.tl, s, m.reduced);
  const expected = landing(m.tl, want, m.reduced);
  check(
    at === expected,
    `${what}: expected beat ${want} at ${expected}, got ${at}`
  );
  check(shownBeat(m.tl, s, m.reduced) === want, `${what}: wrong beat index`);
}

/** The beat a step from `i` should land on (wrapping; -1 counts as "before beat 0"). */
function stepTarget(i: number, dir: 1 | -1, count: number): number {
  if (dir === 1) return i + 1 >= count ? 0 : i + 1;
  return i - 1 < 0 ? count - 1 : i - 1;
}

const clockMachine: hegel.stateful.StateMachine<Machine> = {
  rules: {
    play(_tc, m) {
      const before = shown(m);
      const next = clockStep(m.tl, m.s, { type: "play" }, m.reduced);
      check(next.playing, "play did not start playback");
      const restart = !m.s.playing && !m.s.loop && before >= playEnd(m.tl);
      if (restart) {
        // Playing once from the end starts over from the beginning.
        const start = shownTime(m.tl, { ...next, raw: 0 }, m.reduced);
        check(
          shownTime(m.tl, next, m.reduced) === start,
          `play from the end shows ${shownTime(m.tl, next, m.reduced)}, not the start ${start}`
        );
      } else {
        check(
          shownTime(m.tl, next, m.reduced) === before,
          "starting playback moved the picture"
        );
      }
      m.s = next;
    },
    pause(_tc, m) {
      const before = shown(m);
      const next = clockStep(m.tl, m.s, { type: "pause" }, m.reduced);
      check(!next.playing, "pause left the clock playing");
      check(
        shownTime(m.tl, next, m.reduced) === before,
        "pausing moved the picture"
      );
      m.s = next;
    },
    toggle(_tc, m) {
      const next = clockStep(m.tl, m.s, { type: "toggle" }, m.reduced);
      check(next.playing !== m.s.playing, "toggle did not flip playback");
      m.s = next;
    },
    step(tc, m) {
      tc.assume(n(m) > 0);
      const dir = tc.draw(gs.sampledFrom([1, -1] as const));
      const next = clockStep(m.tl, m.s, { type: "step", dir }, m.reduced);
      landedOnBeat(m, next, stepTarget(beat(m), dir, n(m)), "step");
      m.s = next;
    },
    seek(tc, m) {
      tc.assume(n(m) > 0);
      const i = tc.draw(gs.integers({ minValue: -2, maxValue: n(m) + 2 }));
      const next = clockStep(m.tl, m.s, { type: "seek", beat: i }, m.reduced);
      landedOnBeat(m, next, Math.max(0, Math.min(n(m) - 1, i)), "seek");
      m.s = next;
    },
    playBeat(tc, m) {
      tc.assume(n(m) > 0);
      const i = tc.draw(gs.integers({ minValue: -2, maxValue: n(m) + 2 }));
      const want = Math.max(0, Math.min(n(m) - 1, i));
      const next = clockStep(
        m.tl,
        m.s,
        { type: "playBeat", beat: i },
        m.reduced
      );
      const start = m.tl.beats![want].t;
      const end = beatOutcome(m.tl, want);
      if (m.reduced || !(end > start)) {
        // Nothing to animate: a plain jump to the beat's outcome.
        check(!next.playing, "playing an empty beat left the clock playing");
        check(
          shownTime(m.tl, next, m.reduced) === end,
          `playing beat ${want} without motion drew ${shownTime(m.tl, next, m.reduced)}, not ${end}`
        );
        check(shownBeat(m.tl, next, m.reduced) === want, "wrong beat index");
      } else {
        check(next.playing, "playing a beat did not start playback");
        check(
          next.raw === start,
          `playing beat ${want} started at ${next.raw}, not ${start}`
        );
        check(
          next.until === end,
          `playing beat ${want} stops at ${next.until}, not ${end}`
        );
      }
      m.s = next;
    },
    frame(tc, m) {
      const dir = tc.draw(gs.sampledFrom([1, -1] as const));
      const next = clockStep(m.tl, m.s, { type: "frame", dir }, m.reduced);
      if (m.reduced) {
        // Reduced motion never shows an in-between frame: a frame is a beat.
        const asStep = clockStep(m.tl, m.s, { type: "step", dir }, m.reduced);
        check(
          shownTime(m.tl, next, true) === shownTime(m.tl, asStep, true),
          "a reduced-motion frame step differs from a beat step"
        );
      } else {
        check(!next.playing, "frame step left the clock playing");
        check(
          loopGap(shown(m) + dir * FRAME, next.raw, m.tl.period) < 1e-6,
          `frame step from ${shown(m)} landed on ${next.raw}`
        );
        const back = clockStep(
          m.tl,
          next,
          { type: "frame", dir: dir === 1 ? -1 : 1 },
          false
        );
        check(
          loopGap(m.s.raw, back.raw, m.tl.period) < 1e-6,
          "frame forward then back did not return"
        );
      }
      m.s = next;
    },
    tick(tc, m) {
      const dt = tc.draw(gs.floats({ minValue: 0, maxValue: 0.5 }));
      const next = clockStep(m.tl, m.s, { type: "tick", dt }, m.reduced);
      if (!m.s.playing) {
        check(next === m.s, "a tick moved a paused clock");
      } else {
        check(next.speed === m.s.speed, "a tick changed the speed");
        const want = Math.min(MAX_FRAME_DT, dt) * m.s.speed;
        const end = playEnd(m.tl);
        if (m.s.until !== null && m.s.raw + want >= m.s.until) {
          // Playing one beat: the tick that reaches its outcome stops there.
          check(
            next.raw === m.s.until,
            `beat overran its outcome: ${next.raw}`
          );
          check(
            !next.playing && next.until === null,
            "kept playing past the beat"
          );
        } else if (!m.s.loop && m.s.raw < end && m.s.raw + want >= end) {
          // Playing once: the tick that reaches the end stops exactly there.
          check(next.raw === end, `play-once overran the end: ${next.raw}`);
          check(!next.playing, "play-once kept playing past the end");
        } else {
          check(next.playing, "a tick stopped playback before the end");
          check(
            loopGap(m.s.raw + want, next.raw, m.tl.period) < 1e-6,
            `tick from ${m.s.raw} landed on ${next.raw}, expected +${want} (dt ${dt} at ${m.s.speed}×)`
          );
        }
      }
      m.s = next;
    },
    playThrough(tc, m) {
      // Single ticks rarely carry a beat to its stop; tick until playback
      // stops on its own (a beat's outcome, or the end when playing once).
      tc.assume(m.s.playing && (m.s.until !== null || !m.s.loop));
      const beatStop = m.s.until;
      const target = beatStop ?? playEnd(m.tl);
      const dt = tc.draw(gs.floats({ minValue: 0.01, maxValue: MAX_FRAME_DT }));
      const limit = Math.ceil(m.tl.period / (dt * m.s.speed)) + 2;
      let s = m.s;
      let ticks = 0;
      while (s.playing && ticks < limit) {
        const next = clockStep(m.tl, s, { type: "tick", dt }, m.reduced);
        if (beatStop !== null) {
          check(
            next.raw >= s.raw && next.raw <= beatStop,
            `playing a beat moved ${s.raw} → ${next.raw}, stop ${beatStop}`
          );
          check(
            shownBeat(m.tl, next, m.reduced) ===
              shownBeat(m.tl, m.s, m.reduced),
            "playing a beat drew another beat"
          );
        }
        s = next;
        ticks++;
      }
      check(!s.playing, `still playing after ${ticks} ticks`);
      check(
        s.raw === target && s.until === null,
        `stopped at ${s.raw} (until ${s.until}), not ${target}`
      );
      check(
        shownTime(m.tl, s, m.reduced) === target,
        `drew ${shownTime(m.tl, s, m.reduced)} at the stop, not ${target}`
      );
      if (beatStop !== null) stopsReached.beat++;
      else stopsReached.end++;
      m.s = s;
    },
    speed(tc, m) {
      const speed = tc.draw(gs.sampledFrom(SPEEDS));
      const before = shown(m);
      const next = clockStep(m.tl, m.s, { type: "speed", speed }, m.reduced);
      check(next.speed === speed, "speed not applied");
      check(
        shownTime(m.tl, next, m.reduced) === before,
        "changing speed moved the picture"
      );
      m.s = next;
    },
    loop(tc, m) {
      const loop = tc.draw(gs.booleans());
      const next = clockStep(m.tl, m.s, { type: "loop", loop }, m.reduced);
      check(next.loop === loop, "loop setting not applied");
      check(
        next.raw === m.s.raw && next.playing === m.s.playing,
        "changing loop moved the clock"
      );
      m.s = next;
    },
    reducedMotion(_tc, m) {
      m.reduced = !m.reduced;
    },
  },
  invariants: {
    beatStopOnlyWhilePlaying: {
      alwaysCheck: true,
      check: (_tc, m) => {
        if (m.s.until === null) return;
        check(m.s.playing, "a beat stop is set on a paused clock");
        check(
          m.s.raw <= m.s.until,
          `raw ${m.s.raw} is past the beat stop ${m.s.until}`
        );
      },
    },
    rawInLoop: {
      alwaysCheck: true,
      check: (_tc, m) =>
        check(
          m.s.raw >= 0 && m.s.raw < m.tl.period,
          `raw ${m.s.raw} outside [0, ${m.tl.period})`
        ),
    },
    reducedShowsOnlyOutcomes: {
      alwaysCheck: true,
      check: (_tc, m) => {
        if (!m.reduced || n(m) === 0) return;
        check(
          outcomes(m.tl).includes(shown(m)),
          `reduced motion shows ${shown(m)}, not a beat outcome`
        );
        check(beat(m) >= 0, "reduced motion shows the lead-in");
      },
    },
    beatIndexMatchesTime: {
      alwaysCheck: true,
      check: (_tc, m) =>
        check(
          beat(m) === beatIndex(m.tl.beats ?? [], shown(m)),
          "beat index disagrees with the shown time"
        ),
    },
    speedOffered: (_tc, m) =>
      check(
        (SPEEDS as readonly number[]).includes(m.s.speed),
        "speed is not an offered speed"
      ),
  },
};

test("the clock obeys the player's rules under any sequence of actions", async () => {
  stopsReached.beat = 0;
  stopsReached.end = 0;
  await hegel.test(
    (tc) => {
      const tl = tc.draw(timeline);
      const reduced = tc.draw(gs.booleans());
      const s = initialClock(tl);
      if ((tl.beats?.length ?? 0) > 0)
        check(
          shownTime(tl, s, reduced) === landing(tl, 0, reduced),
          "the clock does not start on the first beat's start"
        );
      check(!s.playing, "the clock starts playing");
      hegel.stateful.run(tc, clockMachine, { tl, s, reduced });
    },
    { testCases: 300 }
  );
  // The runs carried playback all the way to both kinds of stop.
  check(stopsReached.beat > 0, "no run played a beat through to its stop");
  check(stopsReached.end > 0, "no run played once through to the end");
});

test("ticks at 2× cover the same ground as two ticks at 1×", () =>
  hegel.test((tc) => {
    const tl = tc.draw(timeline);
    const raw = tc.draw(
      gs.floats({ minValue: 0, maxValue: tl.period, excludeMax: true })
    );
    const dt = tc.draw(gs.floats({ minValue: 0, maxValue: MAX_FRAME_DT }));
    const at = (speed: number): ClockState => ({
      raw,
      playing: true,
      speed,
      loop: true,
      until: null,
    });
    const fast = clockStep(tl, at(2), { type: "tick", dt }, false);
    const once = clockStep(tl, at(1), { type: "tick", dt }, false);
    const twice = clockStep(tl, once, { type: "tick", dt }, false);
    check(
      loopGap(fast.raw, twice.raw, tl.period) < 1e-9,
      `2× ${fast.raw} vs 1×·2 ${twice.raw}`
    );
  }));

/**
 * Model of the beat a switch lands on: the last beat of `to` starting at or
 * before the story beat `i` of `from` starts at (its first when none does);
 * without story indices, the index (clamped).
 */
function landsOn(from: Timeline, to: Timeline, i: number): number {
  const fb = from.beats ?? [];
  const tb = to.beats ?? [];
  const story = fb[i].story;
  if (story === undefined || tb.some((b) => b.story === undefined))
    return Math.min(i, tb.length - 1);
  const before = tb.filter((b) => b.story! <= story);
  return before.length === 0 ? 0 : before.length - 1;
}

test("switching arrangement keeps the story beat", () =>
  hegel.test((tc) => {
    const a = tc.draw(timeline);
    const b = tc.draw(timeline);
    const na = a.beats?.length ?? 0;
    const nb = b.beats?.length ?? 0;
    tc.assume(na > 0 && nb > 0);
    const reduced = tc.draw(gs.booleans());
    const playing = tc.draw(gs.booleans());
    const i = tc.draw(gs.integers({ minValue: 0, maxValue: na - 1 }));
    const s = {
      ...clockStep(a, initialClock(a), { type: "seek", beat: i }, reduced),
      playing,
    };
    const moved = retarget(a, b, s, reduced);
    const want = landsOn(a, b, i);
    check(
      shownBeat(b, moved, reduced) === want,
      `beat ${i} became ${shownBeat(b, moved, reduced)}`
    );
    check(moved.playing === playing, "switching changed playback");
    // Paused, a switch lands like a seek; playing, it carries on from the
    // beat's outcome (held from its start under reduced motion).
    check(
      shownTime(b, moved, reduced) ===
        (playing && !reduced
          ? beatOutcome(b, want)
          : landing(b, want, reduced)),
      "switching did not land where a seek would"
    );
    check(Math.abs(moved.raw) < b.period + EPS, "raw outside the new loop");
  }));

test("speed steps stay within the offered speeds and move monotonically", () =>
  hegel.test((tc) => {
    const speed = tc.draw(
      gs.oneOf(
        gs.sampledFrom(SPEEDS),
        gs.floats({ minValue: 0.01, maxValue: 8 })
      )
    );
    const up = nextSpeed(speed, 1);
    const down = nextSpeed(speed, -1);
    check((SPEEDS as readonly number[]).includes(up), "faster is not offered");
    check(
      (SPEEDS as readonly number[]).includes(down),
      "slower is not offered"
    );
    check(down <= up, "slower is faster than faster");
    if ((SPEEDS as readonly number[]).includes(speed)) {
      const i = SPEEDS.indexOf(speed as (typeof SPEEDS)[number]);
      check(up === SPEEDS[Math.min(SPEEDS.length - 1, i + 1)], "faster skips");
      check(down === SPEEDS[Math.max(0, i - 1)], "slower skips");
    }
  }));

test("playing once always ends on the last beat, and plays again from the start", () =>
  hegel.test((tc) => {
    const tl = tc.draw(timeline);
    tc.assume(tl.period > 0);
    const reduced = tc.draw(gs.booleans());
    const speed = tc.draw(gs.sampledFrom(SPEEDS));
    const startAt = tc.draw(gs.integers({ minValue: 0, maxValue: 8 }));
    let s = clockStep(
      tl,
      { ...initialClock(tl), speed },
      { type: "seek", beat: startAt },
      reduced
    );
    s = clockStep(tl, s, { type: "play" }, reduced);
    const limit = Math.ceil(tl.period / (MAX_FRAME_DT * speed)) + 2;
    let ticks = 0;
    let last = shownTime(tl, s, reduced);
    while (s.playing && ticks < limit) {
      s = clockStep(tl, s, { type: "tick", dt: MAX_FRAME_DT }, reduced);
      const now = shownTime(tl, s, reduced);
      check(now >= last, `play-once went backwards: ${last} → ${now}`);
      last = now;
      ticks++;
    }
    check(!s.playing, `still playing after ${ticks} ticks`);
    check(
      shownTime(tl, s, reduced) === playEnd(tl),
      `stopped at ${shownTime(tl, s, reduced)}, not the end ${playEnd(tl)}`
    );
    const n = tl.beats?.length ?? 0;
    if (n > 0)
      check(
        shownBeat(tl, s, reduced) === n - 1,
        "did not stop on the last beat"
      );
    // Play again from the end: it starts over instead of stopping at once.
    const again = clockStep(
      tl,
      clockStep(tl, s, { type: "play" }, reduced),
      { type: "tick", dt: 0.01 },
      reduced
    );
    check(again.playing, "playing again from the end stopped immediately");
    check(
      shownTime(tl, again, reduced) <= shownTime(tl, s, reduced),
      "playing again did not start over"
    );
  }));

test("play after any landing animates the landed beat from its start", () =>
  hegel.test((tc) => {
    const tl = tc.draw(timeline);
    const n = tl.beats?.length ?? 0;
    tc.assume(n > 0);
    const base = {
      ...initialClock(tl),
      speed: tc.draw(gs.sampledFrom(SPEEDS)),
    };
    const how = tc.draw(
      gs.sampledFrom(["open", "seek", "next", "back", "home", "end"] as const)
    );
    const to = tc.draw(gs.integers({ minValue: 0, maxValue: n - 1 }));
    const from = clockStep(tl, base, { type: "seek", beat: to }, false);
    const landed =
      how === "open"
        ? base
        : how === "seek"
          ? from
          : how === "next"
            ? clockStep(tl, from, { type: "step", dir: 1 }, false)
            : how === "back"
              ? clockStep(tl, from, { type: "step", dir: -1 }, false)
              : clockStep(
                  tl,
                  base,
                  { type: "seek", beat: how === "home" ? 0 : n - 1 },
                  false
                );
    const i = shownBeat(tl, landed, false);
    const start = tl.beats![i].t;
    const end = beatOutcome(tl, i);
    check(landed.raw === start, `${how} landed on ${landed.raw}, not ${start}`);
    let s = clockStep(tl, landed, { type: "play" }, false);
    check(s.playing, "play did not start");
    // Small ticks pass through the whole beat, from its start, before the next.
    const dt = 0.005;
    const drawn = [shownTime(tl, s, false)];
    const limit = Math.ceil((end - start) / (dt * s.speed)) + 2;
    for (let k = 0; s.playing && k < limit && s.raw < end; k++) {
      s = clockStep(tl, s, { type: "tick", dt }, false);
      drawn.push(shownTime(tl, s, false));
    }
    check(drawn[0] === start, `play began at ${drawn[0]}, not ${start}`);
    for (const t of drawn.filter((t) => t < end))
      check(
        shownBeat(tl, { ...s, raw: t }, false) === i,
        "left the beat early"
      );
    for (let k = 1; k < drawn.length; k++)
      check(
        drawn[k] - drawn[k - 1] <= dt * s.speed + EPS,
        `skipped ${drawn[k - 1]} → ${drawn[k]} inside beat ${i}`
      );
    check(
      drawn[drawn.length - 1] >= end - EPS || !s.playing,
      "never reached the beat's outcome"
    );
  }));

test("playing a beat animates just that beat and stops on its outcome", () =>
  hegel.test((tc) => {
    const tl = tc.draw(timeline);
    const n = tl.beats?.length ?? 0;
    tc.assume(n > 0);
    const reduced = tc.draw(gs.booleans());
    const i = tc.draw(gs.integers({ minValue: 0, maxValue: n - 1 }));
    const from: ClockState = {
      ...initialClock(tl),
      speed: tc.draw(gs.sampledFrom(SPEEDS)),
      loop: tc.draw(gs.booleans()),
      playing: tc.draw(gs.booleans()),
      raw: tc.draw(
        gs.floats({ minValue: 0, maxValue: tl.period, excludeMax: true })
      ),
    };
    const start = tl.beats![i].t;
    const end = beatOutcome(tl, i);
    let s = clockStep(tl, from, { type: "playBeat", beat: i }, reduced);
    const drawn = [shownTime(tl, s, reduced)];
    const limit = Math.ceil(tl.period / (0.02 * from.speed)) + 2;
    for (let k = 0; s.playing && k < limit; k++) {
      const dt = tc.draw(gs.floats({ minValue: 0.02, maxValue: MAX_FRAME_DT }));
      s = clockStep(tl, s, { type: "tick", dt }, reduced);
      drawn.push(shownTime(tl, s, reduced));
    }
    check(!s.playing, "still playing the beat");
    check(
      shownTime(tl, s, reduced) === end,
      `stopped at ${shownTime(tl, s, reduced)}, not ${end}`
    );
    check(
      shownBeat(tl, s, reduced) === shownBeat(tl, { ...s, raw: end }, false),
      "stopped on another beat"
    );
    for (let k = 1; k < drawn.length; k++)
      check(
        drawn[k] >= drawn[k - 1],
        `went backwards: ${drawn[k - 1]} → ${drawn[k]}`
      );
    for (const t of drawn)
      check(
        t >= start - EPS && t <= end + EPS,
        `drew ${t}, outside beat ${i} [${start}, ${end}]`
      );
    if (reduced) {
      check(
        drawn.every((t) => t === end),
        "reduced motion animated the beat"
      );
    } else if (end - start > MAX_FRAME_DT * from.speed) {
      check(drawn[0] === start, "did not start from the beat's start");
      check(new Set(drawn).size > 2, "the beat was not animated");
    }
  }));

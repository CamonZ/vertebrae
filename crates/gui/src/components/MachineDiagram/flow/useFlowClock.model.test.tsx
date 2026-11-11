/**
 * The React clock against its pure model: Hegel drives `useFlowClock` and
 * `clockModel` with the same random sequence of controls, Before/After
 * switches and reduced-motion changes, and the hook must show exactly what
 * the model says. A second machine lets real animation frames run (fake
 * timers) and checks that reduced motion only ever draws beat outcomes,
 * whatever the speed, frame-step and chapter controls did.
 */
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, describe, test, vi } from "vitest";
import * as hegel from "@hegeldev/hegel";
import * as gs from "@hegeldev/hegel/generators";
import inlineDiscussions from "./__fixtures__/inlineDiscussions.flow.yaml?raw";
import type { Timeline } from "../timeline";
import {
  SPEEDS,
  beatOutcome,
  clockStep,
  initialClock,
  retarget,
  shownBeat,
  shownTime,
  type ClockAction,
  type ClockState,
} from "./clockModel";
import { compileFlowOrThrow, parseFlowSpec } from "./index";
import { useFlowClock, type FlowClock } from "./useFlowClock";

function check(condition: boolean, message: string): void {
  if (!condition) throw new Error(message);
}

const parsed = parseFlowSpec(inlineDiscussions);
if (!parsed.ok) throw new Error("fixture does not parse");
const [before, after] = compileFlowOrThrow(parsed.value).arrangements.map(
  (a) => a.travel
);

interface Props {
  tl: Timeline;
  reduced: boolean;
}

interface Lockstep {
  hook: { result: { current: FlowClock }; rerender: (p: Props) => void };
  props: Props;
  model: ClockState;
}

function send(m: Lockstep, a: ClockAction) {
  const c = m.hook.result.current;
  act(() => {
    switch (a.type) {
      case "play":
        return c.play();
      case "pause":
        return c.pause();
      case "toggle":
        return c.toggle();
      case "step":
        return a.dir === 1 ? c.stepForward() : c.stepBack();
      case "frame":
        return a.dir === 1 ? c.frameForward() : c.frameBack();
      case "seek":
        return c.seek(a.beat);
      case "playBeat":
        return c.playBeat(a.beat);
      case "speed":
        return c.setSpeed(a.speed);
      case "loop":
        return c.setLoop(a.loop);
      case "tick":
        return;
    }
  });
  m.model = clockStep(m.props.tl, m.model, a, m.props.reduced);
}

const action = gs.oneOf<ClockAction>(
  gs.sampledFrom<ClockAction>([
    { type: "play" },
    { type: "pause" },
    { type: "toggle" },
    { type: "step", dir: 1 },
    { type: "step", dir: -1 },
    { type: "frame", dir: 1 },
    { type: "frame", dir: -1 },
    { type: "loop", loop: true },
    { type: "loop", loop: false },
  ]),
  gs.composite((tc) => ({
    type: "seek" as const,
    beat: tc.draw(gs.integers({ minValue: -1, maxValue: 10 })),
  })),
  gs.composite((tc) => ({
    type: "playBeat" as const,
    beat: tc.draw(gs.integers({ minValue: -1, maxValue: 10 })),
  })),
  gs.composite((tc) => ({
    type: "speed" as const,
    speed: tc.draw(gs.sampledFrom(SPEEDS)),
  }))
);

const lockstep: hegel.stateful.StateMachine<Lockstep> = {
  rules: {
    control(tc, m) {
      send(m, tc.draw(action));
    },
    switchArrangement(_tc, m) {
      const tl = m.props.tl === after ? before : after;
      m.model = retarget(m.props.tl, tl, m.model, m.props.reduced);
      m.props = { ...m.props, tl };
      act(() => m.hook.rerender(m.props));
    },
    reducedMotion(_tc, m) {
      m.props = { ...m.props, reduced: !m.props.reduced };
      act(() => m.hook.rerender(m.props));
    },
  },
  invariants: {
    hookMatchesModel: {
      alwaysCheck: true,
      check: (_tc, m) => {
        const c = m.hook.result.current;
        const { tl, reduced } = m.props;
        check(
          c.t === shownTime(tl, m.model, reduced),
          `hook shows ${c.t}, model ${shownTime(tl, m.model, reduced)}`
        );
        check(c.playing === m.model.playing, "playing differs from model");
        check(c.speed === m.model.speed, "speed differs from model");
        check(c.loop === m.model.loop, "loop differs from model");
        check(
          c.playing || m.model.until === null,
          "beat stop on a paused clock"
        );
        check(c.beat === shownBeat(tl, m.model, reduced), "beat differs");
        check(c.reducedMotion === reduced, "reduced motion not followed");
        check(c.beatCount === (tl.beats?.length ?? 0), "beat count differs");
      },
    },
  },
};

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("useFlowClock", () => {
  test("follows the clock model under any sequence of controls", () =>
    hegel.test(
      (tc) => {
        const props: Props = {
          tl: tc.draw(gs.sampledFrom([before, after])),
          reduced: tc.draw(gs.booleans()),
        };
        const hook = renderHook(
          (p: Props) => useFlowClock(p.tl, { reducedMotion: p.reduced }),
          { initialProps: props }
        );
        try {
          hegel.stateful.run(
            tc,
            lockstep,
            { hook, props, model: initialClock(props.tl) },
            { stepCount: 30 }
          );
        } finally {
          hook.unmount();
        }
      },
      { testCases: 60 }
    ));

  test("under reduced motion, playback at any speed only draws beat outcomes", () =>
    hegel.test(
      (tc) => {
        vi.useFakeTimers({
          toFake: [
            "requestAnimationFrame",
            "cancelAnimationFrame",
            "performance",
          ],
        });
        const tl = tc.draw(gs.sampledFrom([before, after]));
        const outcomes = new Set(
          (tl.beats ?? []).map((_, i) => beatOutcome(tl, i))
        );
        const hook = renderHook(() =>
          useFlowClock(tl, { reducedMotion: true })
        );
        try {
          const steps = tc.draw(
            gs.arrays(
              gs.oneOf<ClockAction | { type: "wait"; ms: number }>(
                action,
                gs.composite((t) => ({
                  type: "wait" as const,
                  ms: t.draw(gs.integers({ minValue: 16, maxValue: 3000 })),
                }))
              ),
              { minSize: 1, maxSize: 25 }
            )
          );
          for (const s of steps) {
            if (s.type === "wait") {
              act(() => vi.advanceTimersByTime(s.ms));
            } else {
              const m = {
                hook,
                props: { tl, reduced: true },
                model: initialClock(tl),
              };
              send(m, s);
            }
            const t = hook.result.current.t;
            check(outcomes.has(t), `drew ${t}, not a beat outcome`);
          }
        } finally {
          hook.unmount();
          vi.useRealTimers();
        }
      },
      { testCases: 40 }
    ));

  test("2× playback covers twice the ground of 1× in the same time", () => {
    vi.useFakeTimers({
      toFake: ["requestAnimationFrame", "cancelAnimationFrame", "performance"],
    });
    const run = (speed: number) => {
      const hook = renderHook(() =>
        useFlowClock(after, { reducedMotion: false })
      );
      const start = hook.result.current.t;
      act(() => hook.result.current.setSpeed(speed));
      act(() => hook.result.current.play());
      act(() => vi.advanceTimersByTime(800));
      const moved = hook.result.current.t - start;
      hook.unmount();
      return moved;
    };
    const slow = run(1);
    const fast = run(2);
    check(slow > 0.5, `1× moved only ${slow}`);
    check(Math.abs(fast - 2 * slow) < 1e-6, `2× moved ${fast}, 1× ${slow}`);
  });
});

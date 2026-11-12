/**
 * Band rows against the clock model: Hegel drives the flow clock (play,
 * pause, beat and frame steps, seeks, chapters, speed, loop, Before/After
 * switches and reduced-motion changes) over the reference example and the
 * rendered band must light exactly the rows whose beat is showing, and fill
 * exactly the meter rings already passed. One machine runs in lockstep with
 * `clockModel` (no frames); the other lets real animation frames play.
 */
import { act, cleanup, render } from "@testing-library/react";
import { afterEach, describe, test, vi } from "vitest";
import * as hegel from "@hegeldev/hegel";
import * as gs from "@hegeldev/hegel/generators";
import inlineDiscussions from "./__fixtures__/inlineDiscussions.flow.yaml?raw";
import {
  SPEEDS,
  clockStep,
  initialClock,
  retarget,
  shownBeat,
  shownTime,
  type ClockAction,
  type ClockState,
} from "./clockModel";
import { FlowDiagram } from "./FlowDiagram";
import {
  bandRowLit,
  compileFlowOrThrow,
  parseFlowSpec,
  type DiagramTimeline,
} from "./index";
import { useFlowClock, type FlowClock } from "./useFlowClock";

function check(condition: boolean, message: string): void {
  if (!condition) throw new Error(message);
}

const parsed = parseFlowSpec(inlineDiscussions);
if (!parsed.ok) throw new Error("fixture does not parse");
const [before, after] = compileFlowOrThrow(parsed.value).arrangements;

interface Props {
  d: DiagramTimeline;
  reduced: boolean;
}

const clocks: { current: FlowClock | null } = { current: null };

function Harness({ d, reduced }: Props) {
  const clock = useFlowClock(d.travel, { reducedMotion: reduced });
  clocks.current = clock;
  return (
    <FlowDiagram diagram={d} t={clock.t} reducedMotion={clock.reducedMotion} />
  );
}

interface Machine {
  view: ReturnType<typeof render>;
  props: Props;
  model: ClockState;
}

function control(a: ClockAction) {
  const c = clocks.current!;
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

/** Rows lit in the DOM, and the meter's count. */
function drawn(view: Machine["view"]) {
  const rows = [...view.container.querySelectorAll("[data-band-row]")].map(
    (r) => r.getAttribute("data-lit") === "true"
  );
  const meter = view.container.querySelector("[data-testid='flow-band-meter']");
  return { rows, count: Number(meter?.getAttribute("data-count")) };
}

/**
 * The oracle: a row is lit while the beat showing is one it names (the
 * reference rows name captioned beats, so "the beat showing" is the
 * caption's), and the meter counts the markers at or before the shown time.
 */
function expected(d: DiagramTimeline, t: number, beat: number) {
  const id = beat >= 0 ? d.beats[beat]?.id : undefined;
  const names = parsed.ok
    ? (parsed.value as { band: { rows: { beats: string[] }[] } }).band.rows
    : [];
  return {
    rows: names.map((r) => id !== undefined && r.beats.includes(id)),
    count: d.band!.meter!.times.filter((m) => m <= t).length,
  };
}

function rerender(m: Machine) {
  act(() => m.view.rerender(<Harness {...m.props} />));
}

const switches: hegel.stateful.StateMachine<Machine>["rules"] = {
  switchArrangement(_tc, m) {
    const d = m.props.d === after ? before : after;
    m.model = retarget(m.props.d.travel, d.travel, m.model, m.props.reduced);
    m.props = { ...m.props, d };
    rerender(m);
  },
  reducedMotion(_tc, m) {
    m.props = { ...m.props, reduced: !m.props.reduced };
    rerender(m);
  },
};

const lockstep: hegel.stateful.StateMachine<Machine> = {
  rules: {
    control(tc, m) {
      const a = tc.draw(action);
      control(a);
      m.model = clockStep(m.props.d.travel, m.model, a, m.props.reduced);
    },
    ...switches,
  },
  invariants: {
    bandFollowsTheClockModel: {
      alwaysCheck: true,
      check: (_tc, m) => {
        const { d, reduced } = m.props;
        const t = shownTime(d.travel, m.model, reduced);
        const want = expected(d, t, shownBeat(d.travel, m.model, reduced));
        const got = drawn(m.view);
        check(
          JSON.stringify(got.rows) === JSON.stringify(want.rows),
          `${d.arrangement} at ${t}${reduced ? " (reduced)" : ""}: lit ${JSON.stringify(got.rows)}, model ${JSON.stringify(want.rows)}`
        );
        check(
          JSON.stringify(got.rows) ===
            JSON.stringify(d.band!.rows.map((r) => bandRowLit(r, t))),
          `${d.arrangement} at ${t}: lit rows differ from their windows`
        );
        check(
          got.count === want.count,
          `${d.arrangement} at ${t}: meter ${got.count}, model ${want.count}`
        );
      },
    },
  },
};

const playing: hegel.stateful.StateMachine<Machine> = {
  rules: {
    control(tc) {
      control(tc.draw(action));
    },
    wait(tc) {
      const ms = tc.draw(gs.integers({ minValue: 16, maxValue: 2500 }));
      act(() => vi.advanceTimersByTime(ms));
    },
    ...switches,
  },
  invariants: {
    bandFollowsTheShownBeat: {
      alwaysCheck: true,
      check: (_tc, m) => {
        const c = clocks.current!;
        const want = expected(m.props.d, c.t, c.beat);
        const got = drawn(m.view);
        check(
          JSON.stringify(got.rows) === JSON.stringify(want.rows),
          `${m.props.d.arrangement} at ${c.t} beat ${c.beat}${c.reducedMotion ? " (reduced)" : ""}: lit ${JSON.stringify(got.rows)}, want ${JSON.stringify(want.rows)}`
        );
        check(got.count === want.count, `meter ${got.count} at ${c.t}`);
      },
    },
  },
};

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("band rows and meter", () => {
  test("follow the clock model under any sequence of controls", () =>
    hegel.test(
      (tc) => {
        const props: Props = {
          d: tc.draw(gs.sampledFrom([before, after])),
          reduced: tc.draw(gs.booleans()),
        };
        const view = render(<Harness {...props} />);
        try {
          hegel.stateful.run(
            tc,
            lockstep,
            { view, props, model: initialClock(props.d.travel) },
            { stepCount: 30 }
          );
        } finally {
          view.unmount();
        }
      },
      { testCases: 50 }
    ));

  test("follow the beat showing while frames play, with or without reduced motion", () =>
    hegel.test(
      (tc) => {
        vi.useFakeTimers({
          toFake: [
            "requestAnimationFrame",
            "cancelAnimationFrame",
            "performance",
          ],
        });
        const props: Props = {
          d: tc.draw(gs.sampledFrom([before, after])),
          reduced: tc.draw(gs.booleans()),
        };
        const view = render(<Harness {...props} />);
        try {
          hegel.stateful.run(
            tc,
            playing,
            { view, props, model: initialClock(props.d.travel) },
            { stepCount: 25 }
          );
        } finally {
          view.unmount();
          vi.useRealTimers();
        }
      },
      { testCases: 40 }
    ));
});

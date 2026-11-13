/**
 * The player over named arrangements (the three-option reference spec):
 * the selector lists every arrangement, B / ⇧B cycle them, and switching by
 * pointer or key keeps the beat, the pinned part and the followed card while
 * parts keep their place. A Hegel state machine drives random sequences of
 * switches, beat steps and pins against a model of the player.
 */
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
import { afterEach, describe, expect, it, test } from "vitest";
import * as hegel from "@hegeldev/hegel";
import * as gs from "@hegeldev/hegel/generators";
import burstOptions from "./__fixtures__/burstOptions.flow.yaml?raw";
import { FlowPlayer } from "./FlowPlayer";
import {
  arrangement,
  beatOutcome,
  compileFlowOrThrow,
  parseFlowSpec,
  type CompiledFlow,
  type FlowSpec,
} from "./index";
import {
  cycleArrangement,
  playerCommand,
  PLAYER_SHORTCUTS,
} from "./playerKeys";

const parsed = parseFlowSpec(burstOptions);
if (!parsed.ok) throw new Error("fixture does not parse");
const flow = compileFlowOrThrow(parsed.value);
const NAMES = flow.arrangements.map((d) => d.arrangement);

const player = () => screen.getByTestId("flow-player");
const shown = () => player().getAttribute("data-arrangement");
const shownBeat = () => Number(player().getAttribute("data-beat"));
const shownT = () => Number(player().getAttribute("data-t"));
const key = (k: string, init: KeyboardEventInit = {}) =>
  fireEvent.keyDown(document.activeElement ?? player(), { key: k, ...init });
const radios = () =>
  within(screen.getByRole("radiogroup", { name: "Arrangement" })).getAllByRole(
    "radio"
  );
const part = (id: string) =>
  player().querySelector(`[data-part-id='${id}']`) as SVGGElement | null;

function renderPlayer(reducedMotion = false) {
  const r = render(<FlowPlayer flow={flow} reducedMotion={reducedMotion} />);
  act(() => player().focus());
  return r;
}

afterEach(cleanup);

describe("arrangement keys", () => {
  it("B and ⇧B step to the next and previous arrangement", () => {
    expect(playerCommand("b")).toEqual({ kind: "arrangement", dir: 1 });
    expect(playerCommand("B", { shiftKey: true })).toEqual({
      kind: "arrangement",
      dir: -1,
    });
    // Caps Lock types B without Shift.
    expect(playerCommand("B")).toEqual({ kind: "arrangement", dir: 1 });
    expect(playerCommand("b", { metaKey: true })).toBeNull();
    expect(PLAYER_SHORTCUTS.map(([k]) => k)).toContain("B / ⇧B");
  });

  test("cycling visits every arrangement once a round, and back undoes forward", () =>
    hegel.test((tc) => {
      const n = tc.draw(gs.integers({ minValue: 1, maxValue: 6 }));
      const names = Array.from({ length: n }, (_, i) => `a${i}`);
      const start = tc.draw(gs.sampledFrom(names));
      const dir = tc.draw(gs.sampledFrom([1, -1] as const));
      const seen = new Set<string>();
      let at = start;
      for (let i = 0; i < n; i++) {
        seen.add(at);
        const next = cycleArrangement(names, at, dir);
        if (cycleArrangement(names, next, dir === 1 ? -1 : 1) !== at)
          throw new Error(`back from ${next} is not ${at}`);
        at = next;
      }
      if (at !== start || seen.size !== n)
        throw new Error(`a round from ${start} visited ${[...seen]}`);
      if (
        n === 2 &&
        cycleArrangement(names, start, 1) !== cycleArrangement(names, start, -1)
      )
        throw new Error("two arrangements do not toggle");
    }));
});

describe("the arrangement selector", () => {
  it("lists every arrangement by label and starts on the first option", () => {
    renderPlayer();
    expect(radios().map((r) => r.textContent)).toEqual([
      "Current",
      "A · limit + queue",
      "B · queue + journal",
    ]);
    expect(shown()).toBe("A");
    expect(player().getAttribute("aria-keyshortcuts")).toMatch(/ B Shift\+B$/);
  });

  it("switches by pointer and by key, keeping the beat, and morphs between any two", () => {
    renderPlayer();
    key("2");
    expect(shownBeat()).toBe(1);
    fireEvent.click(radios()[2]);
    expect(shown()).toBe("B");
    expect(player()).toHaveAttribute("data-morph", "A→B");
    expect(shownBeat()).toBe(1);
    // Paused, the switch lands on the beat's start, as a seek does.
    expect(shownT()).toBe(arrangement(flow, "B")!.travel.beats![1].t);
    act(() => player().focus());
    key("b");
    expect(shown()).toBe("current");
    expect(player()).toHaveAttribute("data-morph", "B→current");
    key("b");
    expect(shown()).toBe("A");
    key("B", { shiftKey: true });
    expect(shown()).toBe("current");
    expect(shownBeat()).toBe(1);
  });

  it("keeps the pinned part and the followed card across arrangements", () => {
    renderPlayer();
    // j1 is drawn once the first beat has played out.
    key("2");
    key(",");
    fireEvent.click(part("api")!);
    fireEvent.click(
      player().querySelector(".md-card[data-card-id='j1']") as SVGGElement
    );
    act(() => player().focus());
    for (let i = 0; i < NAMES.length; i++) {
      key("b");
      expect(player()).toHaveAttribute("data-following", "j1");
      expect(screen.getByTestId("flow-part-inspector")).toHaveAttribute(
        "data-part-id",
        "api"
      );
      expect(screen.getByTestId("flow-part-inspector")).toHaveTextContent(
        "pinned"
      );
    }
  });

  it("draws every part in the same place in every arrangement", () => {
    renderPlayer(true);
    const where = new Map<string, string>();
    for (const name of NAMES) {
      fireEvent.click(radios()[NAMES.indexOf(name)]);
      expect(shown()).toBe(name);
      for (const p of arrangement(flow, name)!.parts) {
        const g = part(p.id);
        if (p.presence === "absent") continue;
        const t = g!.getAttribute("transform")!;
        expect(where.get(p.id) ?? t).toBe(t);
        where.set(p.id, t);
      }
    }
    expect([...where.keys()].sort()).toEqual([
      "api",
      "buffer",
      "client",
      "limiter",
      "parked",
    ]);
  });

  it("lists a beat's marked steps against the baseline", () => {
    renderPlayer();
    const marks = () =>
      within(screen.getByTestId("flow-chapters"))
        .queryAllByTestId("flow-step-marks")
        .map((m) => m.textContent);
    expect(marks()[0]).toContain("+ rate limiter · send");
    fireEvent.click(radios()[0]);
    expect(marks()).toEqual([]);
  });
});

/* ---------- switching keeps the story beat ---------- */

/** Arrangements that caption different story beats (an uncaptioned one continues). */
const SKIPS = `
version: 1
arrangements: [now, X, Y]
parts:
  - {id: src, kind: source}
  - {id: w, kind: worker}
  - {id: q, kind: queue, in: [X, Y]}
rails:
  - {id: sw, from: src.out, to: w.in}
  - {id: sq, from: src.out, to: q.in}
cards:
  - {id: c0, token: request, origin: src}
  - {id: c1, token: request, origin: src}
  - {id: c2, token: request, origin: src}
  - {id: c3, token: request, origin: src}
story:
  - caption: a job arrives
    steps: [{verb: send, part: src, card: c0}]
  - caption: {now: straight to the worker, X: into the queue}
    steps: [{verb: stage, part: w, card: c0, via: sw}]
  - caption: {X: the queue holds it, Y: the queue takes a second}
    steps: [{verb: send, part: src, card: c1}, {verb: send, part: q, card: c1, via: sq}]
  - caption: {Y: and a third}
    steps: [{verb: send, part: src, card: c2}]
  - caption: done
    steps: [{verb: send, part: src, card: c3}]
`;

function compiledSpec(source: string) {
  const p = parseFlowSpec(source);
  if (!p.ok) throw new Error("spec does not parse");
  return { spec: p.value as FlowSpec, flow: compileFlowOrThrow(p.value) };
}

/**
 * The story beats each arrangement captions, read from the spec alone: a
 * plain caption captions every arrangement, a map those it names.
 */
function captionedStory(spec: FlowSpec, names: readonly string[]) {
  return Object.fromEntries(
    names.map((a) => [
      a,
      (spec.story ?? []).flatMap((b, i) =>
        typeof b.caption === "string" ||
        (b.caption !== undefined && a in b.caption)
          ? [i]
          : []
      ),
    ])
  );
}

describe("switching keeps the story beat", () => {
  const { spec, flow: skips } = compiledSpec(SKIPS);

  it("lands on the beat still showing that story beat", () => {
    render(<FlowPlayer flow={skips} reducedMotion />);
    act(() => player().focus());
    // X: arrives, into the queue, holds it, done. Y: arrives, second, third, done.
    fireEvent.click(radios()[1]);
    key("3"); // X: the queue holds it (story 2)
    fireEvent.click(radios()[0]);
    expect(shownBeat()).toBe(1); // now: straight to the worker (story 1)
    fireEvent.click(radios()[2]);
    expect(shownBeat()).toBe(0); // Y has no story 1: still the arrival
    key("3"); // Y: and a third (story 3)
    fireEvent.click(radios()[1]);
    expect(shownBeat()).toBe(2); // X still shows "the queue holds it"
    expect(captionedStory(spec, ["now", "X", "Y"])).toEqual({
      now: [0, 1, 4],
      X: [0, 1, 2, 4],
      Y: [0, 2, 3, 4],
    });
  });
});

/* ---------- model-based: random switches, steps and pins ---------- */

interface Model {
  arrangement: string;
  /** Story beat the shown beat starts at. */
  story: number;
  pinned: string | null;
}

/**
 * A player over `flow` against a model read from its spec: the shown beat
 * is the story beat's place among the arrangement's captioned ones; a switch
 * keeps the last captioned story beat at or before it.
 */
function playerMachine(
  spec: FlowSpec,
  flow: CompiledFlow
): hegel.stateful.StateMachine<Model> {
  const names = flow.arrangements.map((d) => d.arrangement);
  const captioned = captionedStory(spec, names);
  const parts = flow.arrangements[0].parts.map((p) => p.id);
  const beatOf = (m: Model) => captioned[m.arrangement].indexOf(m.story);
  const switchTo = (m: Model, a: string) => {
    const at = captioned[a].filter((s) => s <= m.story);
    m.story = at.length ? at[at.length - 1] : captioned[a][0];
    m.arrangement = a;
  };
  return {
    rules: {
      pick(tc, m) {
        const i = tc.draw(
          gs.integers({ minValue: 0, maxValue: names.length - 1 })
        );
        fireEvent.click(radios()[i]);
        act(() => player().focus());
        switchTo(m, names[i]);
      },
      cycle(tc, m) {
        const back = tc.draw(gs.booleans());
        key("B", { shiftKey: back });
        switchTo(m, cycleArrangement(names, m.arrangement, back ? -1 : 1));
      },
      step(tc, m) {
        const forward = tc.draw(gs.booleans());
        key(forward ? "ArrowRight" : "ArrowLeft");
        const story = captioned[m.arrangement];
        const n = story.length;
        const i = beatOf(m);
        m.story = story[forward ? (i + 1) % n : (i - 1 + n) % n];
      },
      pin(tc, m) {
        const id = tc.draw(gs.sampledFrom(parts));
        const g = part(id);
        const live =
          arrangement(flow, m.arrangement)!.parts.find((p) => p.id === id)!
            .presence !== "absent";
        tc.assume(g !== null && live);
        fireEvent.click(g!);
        act(() => player().focus());
        m.pinned = m.pinned === id ? null : id;
      },
    },
    invariants: {
      shows: {
        alwaysCheck: true,
        check: (_tc, m) => {
          if (shown() !== m.arrangement)
            throw new Error(`shows ${shown()}, expected ${m.arrangement}`);
          if (shownBeat() !== beatOf(m))
            throw new Error(
              `at beat ${shownBeat()}, expected ${beatOf(m)} (story ${m.story})`
            );
          const d = arrangement(flow, m.arrangement)!;
          if (shownT() !== beatOutcome(d.travel, beatOf(m)))
            throw new Error(
              `at t=${shownT()}, not beat ${beatOf(m)}'s outcome`
            );
          const checked = radios().find(
            (r) => r.getAttribute("aria-checked") === "true"
          );
          if (checked?.textContent !== flow.labels[m.arrangement])
            throw new Error(`selector shows ${checked?.textContent}`);
          const inspector = screen.queryByTestId("flow-part-inspector");
          const live =
            m.pinned !== null &&
            d.parts.find((p) => p.id === m.pinned)!.presence !== "absent";
          if (live !== (inspector?.textContent?.includes("pinned") ?? false))
            throw new Error(
              `pinned ${m.pinned} is ${live ? "hidden" : "shown"}`
            );
        },
      },
    },
  };
}

test.each([
  ["the three-option reference spec", burstOptions],
  ["arrangements captioning different story beats", SKIPS],
])(
  "the player follows any sequence of switches, steps and pins: %s",
  (_, source) => {
    const { spec, flow: f } = compiledSpec(source);
    const first = f.arrangements.find((d) => d.arrangement !== f.baseline)!;
    hegel.test(
      (tc) => {
        cleanup();
        render(<FlowPlayer flow={f} reducedMotion />);
        act(() => player().focus());
        hegel.stateful.run(
          tc,
          playerMachine(spec, f),
          { arrangement: first.arrangement, story: 0, pinned: null },
          { stepCount: 25 }
        );
      },
      { testCases: 30 }
    );
  },
  60_000
);

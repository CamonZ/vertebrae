/**
 * The player over a migration told in phases (the session-per-thread
 * reference spec): the story picks the phase, a boundary morphs once, the
 * clock holds while it does, seeking jumps straight to a beat's phase, and
 * the phase strip shows and seeks phases by pointer and key.
 */
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import sessionMigration from "./__fixtures__/sessionMigration.flow.yaml?raw";
import { FlowPlayer } from "./FlowPlayer";
import { arrangement, compileFlowOrThrow, parseFlowSpec } from "./index";

const parsed = parseFlowSpec(sessionMigration);
if (!parsed.ok) throw new Error("fixture does not parse");
const flow = compileFlowOrThrow(parsed.value);
const PHASES = flow.arrangements.map((d) => d.arrangement);
const beats = flow.arrangements[0].beats;
const firstOf = (phase: string) => beats.findIndex((b) => b.phase === phase);

const player = () => screen.getByTestId("flow-player");
const shown = () => player().getAttribute("data-arrangement");
const shownBeat = () => Number(player().getAttribute("data-beat"));
const shownT = () => Number(player().getAttribute("data-t"));
const morph = () => player().getAttribute("data-morph");
const key = (k: string, init: KeyboardEventInit = {}) =>
  fireEvent.keyDown(document.activeElement ?? player(), { key: k, ...init });
const strip = () => screen.getByRole("navigation", { name: "Phases" });
const phaseButtons = () => within(strip()).getAllByRole("button");

function renderPlayer(reducedMotion = false) {
  const r = render(<FlowPlayer flow={flow} reducedMotion={reducedMotion} />);
  act(() => player().focus());
  return r;
}

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("a phased flow", () => {
  it("starts in the first phase, with a phase strip instead of the selector", () => {
    renderPlayer();
    expect(player()).toHaveAttribute("data-phased", "true");
    expect(shown()).toBe("today");
    expect(screen.queryByRole("radiogroup", { name: "Arrangement" })).toBe(
      null
    );
    expect(phaseButtons().map((b) => b.textContent)).toEqual(
      PHASES.map((p) => flow.labels[p])
    );
    expect(phaseButtons()[0]).toHaveAttribute("aria-current", "step");
    expect(phaseButtons()[0]).toHaveAccessibleName(
      `Phase 1 of ${PHASES.length}: ${flow.labels.today}`
    );
  });

  it("groups the beats under their phase", () => {
    renderPlayer();
    const groups = screen.getAllByTestId("flow-phase-group");
    expect(groups.map((g) => g.getAttribute("data-phase"))).toEqual(PHASES);
    for (const g of groups) {
      const phase = g.getAttribute("data-phase")!;
      const list = within(g).getByRole("list", { name: flow.labels[phase] });
      expect(within(list).getAllByRole("button")).toHaveLength(
        beats.filter((b) => b.phase === phase).length
      );
    }
    // Beats keep one numbering across the groups.
    const all = within(screen.getByTestId("flow-chapters")).getAllByRole(
      "button"
    );
    expect(all.at(-1)).toHaveAccessibleName(
      new RegExp(`^Beat ${beats.length} of ${beats.length}: `)
    );
  });

  it("steps across a boundary with one morph, and back to the earlier phase", () => {
    renderPlayer();
    const p1 = firstOf("flagged");
    key("ArrowRight");
    expect(shownBeat()).toBe(p1 - 1);
    expect(shown()).toBe("today");
    key("ArrowRight");
    expect(shownBeat()).toBe(p1);
    expect(shown()).toBe("flagged");
    expect(morph()).toBe("today→flagged");
    expect(shownT()).toBe(arrangement(flow, "flagged")!.travel.beats![p1].t);
    expect(phaseButtons()[1]).toHaveAttribute("aria-current", "step");
    key("ArrowLeft");
    expect(shownBeat()).toBe(p1 - 1);
    expect(shown()).toBe("today");
    expect(morph()).toBe("flagged→today");
  });

  it("seeks straight to a beat's phase without passing through the others", () => {
    renderPlayer();
    key("End");
    expect(shownBeat()).toBe(beats.length - 1);
    expect(shown()).toBe("target");
    expect(morph()).toBe("today→target");
    key("Home");
    expect(shown()).toBe("today");
    // A beat of the list plays in its phase.
    const all = within(screen.getByTestId("flow-chapters")).getAllByRole(
      "button"
    );
    fireEvent.click(all[firstOf("every")]);
    expect(shown()).toBe("every");
    expect(shownBeat()).toBe(firstOf("every"));
  });

  it("the strip and B / ⇧B seek to a phase's first beat", () => {
    renderPlayer();
    fireEvent.click(phaseButtons()[2]);
    expect(shown()).toBe("every");
    expect(shownBeat()).toBe(firstOf("every"));
    key("b");
    expect(shown()).toBe("target");
    expect(shownBeat()).toBe(firstOf("target"));
    key("B", { shiftKey: true });
    key("B", { shiftKey: true });
    expect(shown()).toBe("flagged");
    expect(shownBeat()).toBe(firstOf("flagged"));
    expect(player().getAttribute("aria-keyshortcuts")).toMatch(/ B Shift\+B$/);
  });

  it("announces the phase with the beat", () => {
    renderPlayer();
    const announcer = () => screen.getByTestId("flow-announcer").textContent;
    expect(announcer()).toMatch(
      new RegExp(
        `^Phase 1 of ${PHASES.length}: ${flow.labels.today}\\. Beat 1 `
      )
    );
    fireEvent.click(phaseButtons()[3]);
    expect(announcer()).toContain(
      `Phase 4 of ${PHASES.length}: ${flow.labels.target}. Beat ${firstOf("target") + 1} of`
    );
  });

  it("playing into a new phase holds on the beat's start while the morph plays", () => {
    vi.useFakeTimers({
      toFake: ["requestAnimationFrame", "cancelAnimationFrame", "performance"],
    });
    renderPlayer();
    const p1 = firstOf("flagged");
    key(String(p1)); // the beat before the boundary
    key(" ");
    let k = 0;
    for (; k < 2000 && shown() === "today"; k++)
      act(() => vi.advanceTimersByTime(16));
    expect(shown()).toBe("flagged");
    expect(shownBeat()).toBe(p1);
    expect(morph()).toBe("today→flagged");
    const held = shownT();
    const start = arrangement(flow, "flagged")!.travel.beats![p1].t;
    expect(held - start).toBeLessThan(0.11);
    // While it morphs the steps wait.
    for (k = 0; k < 2000 && morph() !== null; k++) {
      expect(shownT()).toBe(held);
      act(() => vi.advanceTimersByTime(16));
    }
    expect(morph()).toBe(null);
    expect(player()).toHaveAttribute("data-playing", "true");
    for (k = 0; k < 10; k++) act(() => vi.advanceTimersByTime(16));
    expect(shownT()).toBeGreaterThan(held);
    expect(shown()).toBe("flagged");
  });

  it("under reduced motion a boundary switches the phase without a morph", () => {
    renderPlayer(true);
    key(String(firstOf("flagged") + 1));
    expect(shown()).toBe("flagged");
    expect(morph()).toBe(null);
  });
});

/**
 * The player over a migration told in phases (the session-per-thread
 * reference spec): the story picks the phase, a boundary morphs once, the
 * clock holds while it does, seeking jumps straight to a beat's phase, and
 * the note names the phase, the hairline gaps between phases, and B / ⇧B
 * seek phases.
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
const notePhase = () => screen.getByTestId("flow-note-phase").textContent;
const phaseNote = (k: number) =>
  `Phase ${k + 1} of ${PHASES.length} · ${flow.labels[PHASES[k]]}`;
const dots = () =>
  within(screen.getByTestId("flow-beats")).getAllByRole("button");

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
  it("starts in the first phase, named in the note instead of a selector", () => {
    renderPlayer();
    expect(player()).toHaveAttribute("data-phased", "true");
    expect(shown()).toBe("today");
    expect(screen.queryByRole("radiogroup", { name: "Arrangement" })).toBe(
      null
    );
    expect(notePhase()).toBe(phaseNote(0));
  });

  it("gaps the hairline between phases, with one beat numbering", () => {
    renderPlayer();
    const items = [
      ...screen.getByTestId("flow-beats").querySelectorAll("li"),
    ] as HTMLElement[];
    expect(items.map((li) => li.dataset.phase)).toEqual(
      beats.map((b) => b.phase)
    );
    const starts = items.filter((li) => li.dataset.phaseStart === "true");
    expect(starts.map((li) => li.dataset.phase)).toEqual(PHASES.slice(1));
    for (const li of starts) expect(li.className).toMatch(/\bml-4\b/);
    expect(dots().at(-1)).toHaveAccessibleName(
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
    expect(notePhase()).toBe(phaseNote(1));
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
    // A dot plays its beat in its phase.
    fireEvent.click(dots()[firstOf("every")]);
    expect(shown()).toBe("every");
    expect(shownBeat()).toBe(firstOf("every"));
  });

  it("a phase's first dot and B / ⇧B seek to a phase's first beat", () => {
    renderPlayer();
    fireEvent.click(dots()[firstOf("every")]);
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
    fireEvent.click(dots()[firstOf("target")]);
    expect(announcer()).toContain(
      `Phase 4 of ${PHASES.length}: ${flow.labels.target}. Beat ${firstOf("target") + 1} of`
    );
  });

  // Hundreds of 16ms act() steps render each frame; CI runners take 3-6s.
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
  }, 15_000);

  it("under reduced motion a boundary switches the phase without a morph", () => {
    renderPlayer(true);
    key(String(firstOf("flagged") + 1));
    expect(shown()).toBe("flagged");
    expect(morph()).toBe(null);
  });
});

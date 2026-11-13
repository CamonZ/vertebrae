import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import inlineDiscussions from "./__fixtures__/inlineDiscussions.flow.yaml?raw";
import { FlowPlayer } from "./FlowPlayer";
import {
  arrangement,
  beatAnnouncement,
  beatOutcome,
  cardWhereabouts,
  compileFlowOrThrow,
  parseFlowSpec,
} from "./index";
import { leaveToTarget, playerCommand } from "./playerKeys";

const parsed = parseFlowSpec(inlineDiscussions);
if (!parsed.ok) throw new Error("fixture does not parse");
const flow = compileFlowOrThrow(parsed.value);
const after = arrangement(flow, "after")!;
const before = arrangement(flow, "before")!;
const outcomes = after.beats.map((_, i) => beatOutcome(after.travel, i));

const player = () => screen.getByTestId("flow-player");
const shownT = () => Number(player().getAttribute("data-t"));
const shownBeat = () => Number(player().getAttribute("data-beat"));
const key = (k: string, init: KeyboardEventInit = {}) =>
  fireEvent.keyDown(document.activeElement ?? player(), { key: k, ...init });
const chapterButtons = () =>
  within(screen.getByTestId("flow-chapters")).getAllByRole("button");
const progressBars = () =>
  within(screen.getByTestId("flow-chapters"))
    .getAllByTestId("flow-beat-progress")
    .map((bar) =>
      Number(/scaleY\(([^)]+)\)/.exec(bar.style.transform)?.[1] ?? NaN)
    );
const part = (id: string) =>
  player().querySelector(`[data-part-id='${id}']`) as SVGGElement;

function renderPlayer(props: Partial<Parameters<typeof FlowPlayer>[0]> = {}) {
  const r = render(<FlowPlayer flow={flow} reducedMotion={false} {...props} />);
  act(() => player().focus());
  return r;
}

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("keyboard control", () => {
  it("drives every control from the keyboard", () => {
    renderPlayer();
    key("ArrowRight");
    expect(shownBeat()).toBe(1);
    expect(shownT()).toBe(outcomes[1]);
    key("ArrowLeft");
    expect(shownBeat()).toBe(0);
    key(".");
    expect(shownT()).toBeCloseTo(outcomes[0] + 1 / 30, 9);
    key(",");
    expect(shownT()).toBeCloseTo(outcomes[0], 9);
    key("ArrowRight", { shiftKey: true });
    expect(shownT()).toBeCloseTo(outcomes[0] + 1 / 30, 9);
    key("3");
    expect(shownBeat()).toBe(2);
    key("End");
    expect(shownBeat()).toBe(after.beats.length - 1);
    key("Home");
    expect(shownBeat()).toBe(0);
    key("+");
    expect(player()).toHaveAttribute("data-speed", "2");
    key("-");
    key("-");
    expect(player()).toHaveAttribute("data-speed", "0.5");
    key(" ");
    expect(player()).toHaveAttribute("data-playing", "true");
    key("k");
    expect(player()).toHaveAttribute("data-playing", "false");
    key("b");
    expect(player()).toHaveAttribute("data-arrangement", "before");
    key("?");
    expect(screen.getByTestId("flow-shortcuts")).toBeInTheDocument();
    key("Escape");
    expect(screen.queryByTestId("flow-shortcuts")).toBeNull();
  });

  it("leaves modified keys to the app", () => {
    renderPlayer();
    key("ArrowRight", { metaKey: true });
    key("ArrowRight", { ctrlKey: true });
    expect(shownBeat()).toBe(0);
  });

  it("every control and part is in the tab order with a focus style", () => {
    renderPlayer();
    const buttons = within(player()).getAllByRole("button");
    for (const b of buttons) {
      expect(b.tabIndex).toBe(0);
    }
    // Player controls draw an accent ring; the shared zoom widget gets one
    // from MachineDiagram.css (.md-viewport .uv-zoom button:focus-visible).
    for (const b of buttons.filter(
      (b) => b.tagName === "BUTTON" && !b.closest(".uv-zoom")
    ))
      expect(b.className).toMatch(/focus-visible:ring/);
    const parts = after.parts.filter((p) => p.presence !== "absent");
    for (const p of parts) {
      expect(part(p.id)).toHaveAttribute("tabindex", "0");
      expect(part(p.id)).toHaveAttribute("role", "button");
      // The ring that marks focus in the diagram (MachineDiagram.css).
      expect(part(p.id).querySelector(".md-part-ring")).not.toBeNull();
    }
    for (const g of within(player()).getAllByRole("radiogroup"))
      expect(
        within(g)
          .getAllByRole("radio")
          .some((r) => r.tabIndex === 0)
      ).toBe(true);
    expect(player().className).toMatch(/focus-visible:ring/);
  });

  it("buttons keep Space and Enter; radio groups keep their arrows", () => {
    const root = document.createElement("div");
    const button = document.createElement("button");
    const group = document.createElement("div");
    group.setAttribute("role", "radiogroup");
    const radio = document.createElement("button");
    radio.setAttribute("role", "radio");
    group.append(radio);
    root.append(button, group);
    expect(leaveToTarget(button, root, " ")).toBe(true);
    expect(leaveToTarget(button, root, "ArrowRight")).toBe(false);
    expect(leaveToTarget(radio, root, "ArrowRight")).toBe(true);
    expect(leaveToTarget(root, root, " ")).toBe(false);
    expect(playerCommand("5")).toEqual({ kind: "seek", beat: 4 });
    expect(playerCommand("0")).toBeNull();
    expect(playerCommand("x")).toBeNull();
  });
});

describe("chapters and announcements", () => {
  it("each beat is a chapter that plays just that beat, then pauses on its outcome", () => {
    vi.useFakeTimers({
      toFake: ["requestAnimationFrame", "cancelAnimationFrame", "performance"],
    });
    renderPlayer();
    const chapters = within(screen.getByTestId("flow-chapters")).getAllByRole(
      "button"
    );
    expect(chapters).toHaveLength(after.beats.length);
    const start = after.beats[4].t;
    fireEvent.click(chapters[4]);
    expect(player()).toHaveAttribute("data-playing", "true");
    expect(shownT()).toBe(start);
    expect(shownBeat()).toBe(4);
    const seen: number[] = [];
    for (let k = 0; k < 600 && player().dataset.playing === "true"; k++) {
      act(() => vi.advanceTimersByTime(16));
      seen.push(shownT());
      expect(shownBeat()).toBe(4);
    }
    expect(player()).toHaveAttribute("data-playing", "false");
    expect(shownT()).toBe(outcomes[4]);
    // It animated: frames in between the beat's start and its outcome.
    expect(
      seen.filter((t) => t > start && t < outcomes[4]).length
    ).toBeGreaterThan(5);
    // Clicking it again replays the beat.
    fireEvent.click(chapters[4]);
    expect(shownT()).toBe(start);
    expect(chapters[4]).toHaveAttribute("aria-current", "step");
    expect(chapters[4]).toHaveAccessibleName(
      `Beat 5 of ${after.beats.length}: ${after.beats[4].caption}`
    );
  });

  it("Enter or Space on a focused beat plays that beat", async () => {
    const user = userEvent.setup();
    renderPlayer();
    const chapters = chapterButtons();
    chapters[3].focus();
    await user.keyboard("{Enter}");
    expect(player()).toHaveAttribute("data-playing", "true");
    expect(shownBeat()).toBe(3);
    expect(shownT()).toBeGreaterThanOrEqual(after.beats[3].t);
    expect(shownT()).toBeLessThanOrEqual(outcomes[3]);

    chapters[5].focus();
    await user.keyboard(" ");
    // Space plays the beat; the player does not also toggle playback.
    expect(player()).toHaveAttribute("data-playing", "true");
    expect(shownBeat()).toBe(5);
    expect(shownT()).toBeGreaterThanOrEqual(after.beats[5].t);
    expect(shownT()).toBeLessThanOrEqual(outcomes[5]);
    expect(chapters[5]).toHaveAttribute("aria-current", "step");
  });

  it("clamps long captions on beats other than the current one", () => {
    const long = `${"A very long caption that keeps going ".repeat(8)}to the end.`;
    const withLong = {
      ...flow,
      arrangements: flow.arrangements.map((a) => ({
        ...a,
        beats: a.beats.map((b, i) => (i === 1 ? { ...b, caption: long } : b)),
      })),
    };
    renderPlayer({ flow: withLong });
    const caption = () =>
      chapterButtons()[1].querySelector("span:last-child") as HTMLElement;
    expect(caption()).toHaveClass("line-clamp-2");
    // The full caption stays available: as a tooltip and the accessible name.
    expect(chapterButtons()[1]).toHaveAttribute("title", long);
    expect(chapterButtons()[1]).toHaveAccessibleName(
      `Beat 2 of ${after.beats.length}: ${long}`
    );
    key("2");
    expect(caption()).not.toHaveClass("line-clamp-2");
    expect(caption()).toHaveTextContent(long);
    expect(chapterButtons()[1]).not.toHaveAttribute("title");
    expect(chapterButtons()[0].querySelector("span:last-child")).toHaveClass(
      "line-clamp-2"
    );
  });

  it("draws a progress bar per beat: done, current and still to come", () => {
    renderPlayer();
    const n = after.beats.length;
    key("3");
    // Resting on beat 3's outcome: it and every earlier beat read full.
    expect(progressBars()).toEqual(
      Array.from({ length: n }, (_, i) => (i <= 2 ? 1 : 0))
    );
    // Part way through the beat, the current bar is part full.
    for (let f = 0; f < 15; f++) key(",");
    expect(shownBeat()).toBe(2);
    const mid = progressBars()[2];
    expect(mid).toBeGreaterThan(0);
    expect(mid).toBeLessThan(1);
    key(",");
    expect(progressBars()[2]).toBeLessThan(mid);
    expect(progressBars().slice(0, 2)).toEqual([1, 1]);
    expect(
      progressBars()
        .slice(3)
        .every((p) => p === 0)
    ).toBe(true);
  });

  it("keeps the current beat scrolled into view inside the list", () => {
    renderPlayer();
    const list = screen.getByTestId("flow-chapters");
    // jsdom has no layout: give the list a 100px window over 50px rows.
    Object.defineProperty(list, "clientHeight", { value: 100 });
    [...list.children].forEach((li, i) => {
      Object.defineProperty(li, "offsetTop", { value: i * 50 });
      Object.defineProperty(li, "offsetHeight", { value: 50 });
    });
    const n = after.beats.length;
    expect(n * 50).toBeGreaterThan(100);
    key("End");
    expect(list.scrollTop).toBe(n * 50 - 100);
    key("Home");
    expect(list.scrollTop).toBe(0);
    key("5");
    expect(list.scrollTop).toBe(5 * 50 - 100);
    // A beat already in view does not scroll the list.
    key("4");
    expect(list.scrollTop).toBe(5 * 50 - 100);
  });

  it("announces the beat caption through a live region", () => {
    renderPlayer();
    const live = screen.getByTestId("flow-announcer");
    expect(live).toHaveAttribute("aria-live", "polite");
    expect(live).toHaveTextContent(
      `Beat 1 of ${after.beats.length}: ${after.beats[0].caption}`
    );
    key("ArrowRight");
    expect(live).toHaveTextContent(
      `Beat 2 of ${after.beats.length}: ${after.beats[1].caption}`
    );
  });

  it("a part's accessible name carries its current state", () => {
    renderPlayer();
    key("2");
    expect(part("tools").getAttribute("aria-label")).toMatch(/ Now: .+\.$/);
  });
});

describe("parts", () => {
  it("click, Enter and Space all call the one activation callback with the part id", () => {
    const onActivatePart = vi.fn();
    renderPlayer({ onActivatePart });
    fireEvent.click(part("process"));
    act(() => part("tools").focus());
    fireEvent.keyDown(part("tools"), { key: "Enter" });
    fireEvent.keyDown(part("tools"), { key: " " });
    expect(onActivatePart.mock.calls).toEqual([
      ["process"],
      ["tools"],
      ["tools"],
    ]);
    // Space on a part activates it; it does not also start playback.
    expect(player()).toHaveAttribute("data-playing", "false");
  });

  it("hover or focus shows the part's state and source refs; activation pins it", () => {
    renderPlayer();
    fireEvent.mouseEnter(part("process"));
    const inspector = screen.getByTestId("flow-part-inspector");
    expect(inspector).toHaveAttribute("data-part-id", "process");
    expect(within(inspector).getByTestId("flow-part-state")).toHaveTextContent(
      /now/
    );
    expect(inspector).toHaveTextContent(
      "crates/harness-claude/src/config.rs:33"
    );
    expect(inspector).toHaveTextContent("verified");
    fireEvent.mouseLeave(part("process"));
    expect(screen.queryByTestId("flow-part-inspector")).toBeNull();

    act(() => part("tools").focus());
    expect(screen.getByTestId("flow-part-inspector")).toHaveAttribute(
      "data-part-id",
      "tools"
    );
    fireEvent.keyDown(part("tools"), { key: "Enter" });
    act(() => part("tools").blur());
    expect(screen.getByTestId("flow-part-inspector")).toHaveTextContent(
      "pinned"
    );
    expect(part("tools")).toHaveAttribute("data-active", "true");
    act(() => player().focus());
    key("Escape");
    expect(screen.queryByTestId("flow-part-inspector")).toBeNull();
  });

  it("a hovered part's inspector moves nothing under the pointer and lets it through; pinned, it takes input", () => {
    renderPlayer();
    const bottom = screen.getByTestId("flow-bottom-panel");
    const before = [...bottom.children];
    fireEvent.mouseEnter(part("process"));
    const inspector = screen.getByTestId("flow-part-inspector");
    // The stack is anchored at its foot: the inspector opens above it all.
    expect(bottom.firstElementChild).toContainElement(inspector);
    expect([...bottom.children].slice(1)).toEqual(before);
    expect(inspector).toHaveClass("pointer-events-none");
    expect(inspector).not.toHaveClass("pointer-events-auto");
    fireEvent.click(part("process"));
    expect(screen.getByTestId("flow-part-inspector")).toHaveClass(
      "pointer-events-auto"
    );
  });
});

describe("following a card", () => {
  it("shows the payload and keeps the card highlighted across beats and parts", () => {
    renderPlayer();
    const q1 = () =>
      [
        ...player().querySelectorAll(".md-card[data-card-id='q1']"),
      ] as SVGGElement[];
    // q1 is drawn on the first beat's outcome.
    expect(q1().length).toBeGreaterThan(0);
    fireEvent.click(q1()[0]);
    expect(player()).toHaveAttribute("data-following", "q1");
    const payload = screen.getByTestId("flow-card-payload");
    expect(payload).toHaveTextContent("Please explain what this file does");
    expect(payload).toHaveTextContent("text");

    const layers = new Set<string>();
    for (let i = 0; i < after.beats.length; i++) {
      key(String(i + 1));
      for (const g of q1()) {
        expect(g).toHaveAttribute("data-followed", "true");
        layers.add(
          g.closest("[data-part-id]")?.getAttribute("data-part-id") ?? "rail"
        );
      }
      for (const g of player().querySelectorAll(
        ".md-card[data-card-id]:not([data-card-id='q1'])"
      ))
        expect(g).not.toHaveAttribute("data-followed");
      expect(screen.getByTestId("flow-narration")).toHaveTextContent(/^Q1 /);
      expect(screen.getByTestId("flow-card-payload")).toBeInTheDocument();
    }
    // Followed between frames too: step back frame by frame through q1's
    // trip from the client to the session.
    key("1");
    const frames = Math.ceil((outcomes[0] - after.beats[0].t) * 30) + 1;
    for (let f = 0; f < frames; f++) {
      key(",");
      for (const g of q1()) {
        expect(g).toHaveAttribute("data-followed", "true");
        layers.add(
          g.closest("[data-part-id]")?.getAttribute("data-part-id") ?? "rail"
        );
      }
    }
    // It was followed in the client, on the ask rail and in the session.
    expect([...layers].sort()).toEqual(["process", "rail", "you"]);
    key("Escape");
    expect(player()).not.toHaveAttribute("data-following");
    expect(screen.queryByTestId("flow-card-payload")).toBeNull();
  });

  it("narrates where the followed card is, in the live region per beat", () => {
    renderPlayer();
    fireEvent.click(
      player().querySelector(".md-card[data-card-id='q1']") as SVGGElement
    );
    key("ArrowRight");
    const t = beatOutcome(after.travel, 1);
    const where = cardWhereabouts(after, "q1", t);
    expect(where.kind).not.toBe("pending");
    expect(screen.getByTestId("flow-announcer")).toHaveTextContent(/Q1 /);
  });

  it("Enter on a focused card follows it", () => {
    renderPlayer();
    const card = player().querySelector(
      ".md-card[data-card-id='q1']"
    ) as SVGGElement;
    expect(card).toHaveAttribute("role", "button");
    act(() => card.focus());
    fireEvent.keyDown(card, { key: "Enter" });
    expect(player()).toHaveAttribute("data-following", "q1");
  });
});

describe("reduced motion", () => {
  it("speed, frame-step and chapter controls only ever show beat outcomes", () => {
    vi.useFakeTimers({
      toFake: ["requestAnimationFrame", "cancelAnimationFrame", "performance"],
    });
    renderPlayer({ reducedMotion: true });
    const seen = new Set<number>();
    const look = () => seen.add(shownT());
    for (const k of [".", ".", ",", "+", " ", "5", "-", "End", " "]) {
      key(k);
      look();
      act(() => vi.advanceTimersByTime(700));
      look();
    }
    for (const t of seen) expect(outcomes).toContain(t);
    expect(seen.size).toBeGreaterThan(2);
  });

  it("clicking beats in the list, playing or paused, only draws settled beats", () => {
    vi.useFakeTimers({
      toFake: ["requestAnimationFrame", "cancelAnimationFrame", "performance"],
    });
    renderPlayer({ reducedMotion: true });
    const seen = new Set<number>();
    const look = () => {
      seen.add(shownT());
      expect(outcomes).toContain(shownT());
      // The current beat is settled, so its bar reads full.
      expect(progressBars()[shownBeat()]).toBe(1);
      expect(chapterButtons()[shownBeat()]).toHaveAttribute(
        "aria-current",
        "step"
      );
    };
    const run = (ms: number) => {
      for (let k = 0; k < ms; k += 16) {
        act(() => vi.advanceTimersByTime(16));
        look();
      }
    };
    for (const i of [4, 1, 6]) {
      fireEvent.click(chapterButtons()[i]);
      expect(player()).toHaveAttribute("data-playing", "false");
      expect(shownBeat()).toBe(i);
      look();
      run(200);
    }
    // While playing: a click lands on the beat's outcome and holds there.
    key(" ");
    run(400);
    for (const i of [2, 7, 0]) {
      fireEvent.click(chapterButtons()[i]);
      expect(shownBeat()).toBe(i);
      look();
      key(" ");
      run(1500);
    }
    expect(seen.size).toBeGreaterThan(4);
  }, 30_000); // Room for slow CI runners.

  it("a chapter shows its beat's outcome at once under reduced motion", () => {
    renderPlayer({ reducedMotion: true });
    const chapters = within(screen.getByTestId("flow-chapters")).getAllByRole(
      "button"
    );
    fireEvent.click(chapters[4]);
    expect(player()).toHaveAttribute("data-playing", "false");
    expect(shownT()).toBe(outcomes[4]);
  });

  it("Before keeps the story beat under reduced motion too", () => {
    renderPlayer({ reducedMotion: true });
    // After's beat 4 ("edit attempt denied") has no Before caption, so
    // Before still shows Q2, its beat 3; After's Q3 is Before's beat 4.
    key("4");
    key("b");
    expect(shownBeat()).toBe(2);
    expect(shownT()).toBe(beatOutcome(before.travel, 2));
    key("b");
    key("5");
    key("b");
    expect(shownBeat()).toBe(3);
    expect(shownT()).toBe(beatOutcome(before.travel, 3));
  });
});

describe("announcement text", () => {
  it("ends each sentence once, whatever the caption's punctuation", () => {
    for (let i = 0; i < after.beats.length; i++) {
      const text = beatAnnouncement(after, i, "Q1 is done");
      expect(text).not.toMatch(/[.!?…]\./);
      expect(text).toMatch(/Q1 is done\.$/);
    }
  });
});

describe("play once or loop", () => {
  it("plays once by default and stops on the last beat; Loop keeps going", () => {
    vi.useFakeTimers({
      toFake: ["requestAnimationFrame", "cancelAnimationFrame", "performance"],
    });
    renderPlayer();
    const loop = screen.getByRole("button", { name: "Loop" });
    expect(loop).toHaveAttribute("aria-pressed", "false");
    expect(player()).toHaveAttribute("data-loop", "false");
    const n = after.beats.length;
    key(String(n - 1));
    fireEvent.click(screen.getByRole("button", { name: "Play" }));
    act(() => vi.advanceTimersByTime(after.period * 1000));
    expect(player()).toHaveAttribute("data-playing", "false");
    expect(shownBeat()).toBe(n - 1);
    expect(shownT()).toBe(outcomes[n - 1]);

    // Play from the end starts over.
    fireEvent.click(screen.getByRole("button", { name: "Play" }));
    act(() => vi.advanceTimersByTime(200));
    expect(player()).toHaveAttribute("data-playing", "true");
    expect(shownT()).toBeLessThan(outcomes[0]);

    // Loop on (button or L): playback runs past the end and wraps.
    key("l");
    expect(screen.getByRole("button", { name: "Loop" })).toHaveAttribute(
      "aria-pressed",
      "true"
    );
    act(() => vi.advanceTimersByTime(after.period * 1000 + 500));
    expect(player()).toHaveAttribute("data-playing", "true");
    fireEvent.click(screen.getByRole("button", { name: "Loop" }));
    expect(player()).toHaveAttribute("data-loop", "false");
  });
});

describe("hiding the beats and resizing the diagram", () => {
  const beatsToggle = () =>
    screen.getByRole("button", { name: /^(Hide|Show) beats$/ });
  const chaptersPanel = () => screen.getByTestId("flow-chapters-panel");
  /** Everything playback-related the reader would lose on a reset. */
  const playback = () => ({
    beat: player().getAttribute("data-beat"),
    t: player().getAttribute("data-t"),
    playing: player().getAttribute("data-playing"),
    arrangement: player().getAttribute("data-arrangement"),
    following: player().getAttribute("data-following"),
    pinned: screen.queryByTestId("flow-part-inspector")?.textContent ?? null,
  });
  /** Following q1, the tools part pinned, at beat 3. */
  function placeInStory() {
    fireEvent.click(
      player().querySelector(".md-card[data-card-id='q1']") as SVGGElement
    );
    fireEvent.click(part("tools"));
    act(() => player().focus());
    key("3");
    const state = playback();
    expect(state.beat).toBe("2");
    expect(state.following).toBe("q1");
    expect(state.pinned).toMatch(/pinned/);
    return state;
  }

  it("the toggle hides and shows the beats list by pointer and by C", () => {
    renderPlayer();
    const toggle = beatsToggle();
    expect(toggle).toHaveAttribute("aria-expanded", "true");
    expect(toggle).toHaveAttribute("aria-controls", chaptersPanel().id);
    expect(chaptersPanel()).toBeVisible();

    fireEvent.click(toggle);
    expect(chaptersPanel()).not.toBeVisible();
    expect(beatsToggle()).toHaveAttribute("aria-expanded", "false");
    expect(beatsToggle()).toHaveAccessibleName("Show beats");

    act(() => player().focus());
    key("c");
    expect(chaptersPanel()).toBeVisible();
    key("C");
    expect(chaptersPanel()).not.toBeVisible();
  });

  it("the beats and the controls float over the diagram, which fills the frame", () => {
    renderPlayer();
    const frame = screen.getByTestId("machine-diagram-viewport");
    const bottom = screen.getByTestId("flow-bottom-panel");
    expect(frame).toContainElement(chaptersPanel());
    expect(frame).toContainElement(bottom);
    expect(bottom).toContainElement(
      screen.getByRole("button", { name: "Next beat" })
    );
    // The grip is the frame's foot, below the floating controls.
    const grip = screen.getByRole("separator", { name: "Resize diagram" });
    expect(frame.nextElementSibling).toBe(grip);
    // With the beats hidden the controls take the full width.
    expect(bottom.className).toMatch(/right-\[calc/);
    key("c");
    expect(bottom.className).toMatch(/\bright-4\b/);
  });

  it("lists the beats shortcut in the help", () => {
    renderPlayer();
    key("?");
    expect(screen.getByTestId("flow-shortcuts")).toHaveTextContent(
      "show or hide the beats"
    );
  });

  it("does not reset playback, the pinned part or the followed card", () => {
    renderPlayer();
    const state = placeInStory();
    key("c");
    expect(playback()).toEqual(state);
    fireEvent.click(beatsToggle());
    expect(playback()).toEqual(state);
  });

  it("shown again, the list brings the current beat into view", () => {
    renderPlayer();
    const list = screen.getByTestId("flow-chapters");
    Object.defineProperty(list, "clientHeight", { value: 100 });
    [...list.children].forEach((li, i) => {
      Object.defineProperty(li, "offsetTop", { value: i * 50 });
      Object.defineProperty(li, "offsetHeight", { value: 50 });
    });
    key("c");
    list.scrollTop = 0;
    key("End");
    key("c");
    expect(list.scrollTop).toBe(after.beats.length * 50 - 100);
  });

  it("resizing the diagram with its grip does not reset playback", () => {
    renderPlayer();
    const state = placeInStory();
    const grip = screen.getByRole("separator", { name: "Resize diagram" });
    const frame = screen.getByTestId("machine-diagram-viewport");
    vi.spyOn(frame, "getBoundingClientRect").mockImplementation(
      () => ({ height: parseFloat(frame.style.height) }) as DOMRect
    );
    const before = frame.style.height;
    expect(grip).toHaveAttribute("aria-valuemin", "320");
    act(() => grip.focus());
    fireEvent.keyDown(grip, { key: "ArrowDown" });
    expect(frame.style.height).not.toBe(before);
    expect(playback()).toEqual(state);
  });

  it("has no beats toggle when the flow has no beats", () => {
    const noBeats = {
      ...flow,
      arrangements: flow.arrangements.map((a) => ({ ...a, beats: [] })),
    };
    render(<FlowPlayer flow={noBeats} reducedMotion={false} />);
    expect(
      screen.queryByRole("button", { name: /beats$/ })
    ).not.toBeInTheDocument();
  });
});

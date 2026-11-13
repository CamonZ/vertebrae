import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ReactNode } from "react";
import inlineDiscussions from "../MachineDiagram/flow/__fixtures__/inlineDiscussions.flow.yaml?raw";
import {
  arrangement,
  beatOutcome,
  compileFlowOrThrow,
  createFlowRegistry,
  FlowRegistryContext,
  parseFlowSpec,
  type FlowRegistry,
  type PartKindDef,
} from "../MachineDiagram/flow";
import { MarkdownContent } from "./MarkdownContent";

vi.mock("../../bindings", () => ({
  commands: { listArtifactPresentations: vi.fn() },
}));
vi.mock("./CodeSnippet", () => ({
  default: ({ source }: { source: string }) => <code>{source}</code>,
}));

const fence = (body: string) =>
  `Here is the flow:\n\n\`\`\`flow\n${body}\n\`\`\`\n`;

function renderFlow(body: string, wrap?: (n: ReactNode) => ReactNode) {
  const node = <MarkdownContent text={fence(body)} />;
  return render(<>{wrap ? wrap(node) : node}</>);
}

const player = () => screen.getByTestId("flow-player");
const shownT = () => Number(player().getAttribute("data-t"));
const shownBeat = () => Number(player().getAttribute("data-beat"));

const parsed = parseFlowSpec(inlineDiscussions);
if (!parsed.ok) throw new Error("fixture does not parse");
const compiled = compileFlowOrThrow(parsed.value);
const after = arrangement(compiled, "after")!;
const before = arrangement(compiled, "before")!;
const afterOutcomes = after.beats.map((_, i) => beatOutcome(after.travel, i));

/** A spec without change marks: one arrangement, no toggle. */
const plainSpec = `
version: 1
parts:
  - { id: src, kind: source, position: { x: 0, y: 0 } }
  - { id: w, kind: worker, position: { x: 400, y: 0 } }
rails:
  - { id: jobs, from: src.out, to: w.in }
cards:
  - { id: job, token: request, label: J }
story:
  - caption: a job is sent
    steps:
      - { verb: send, part: src, card: job }
  - caption: the worker runs it
    steps:
      - { verb: stage, part: w, card: job, via: jobs }
      - { verb: finish, part: w, card: job }
`;

function mockReducedMotion(reduce: boolean) {
  window.matchMedia = vi.fn().mockImplementation((query: string) => ({
    matches: reduce && query.includes("prefers-reduced-motion"),
    media: query,
    onchange: null,
    addListener: vi.fn(),
    removeListener: vi.fn(),
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    dispatchEvent: vi.fn(),
  })) as unknown as typeof window.matchMedia;
}

const originalMatchMedia = window.matchMedia;
afterEach(() => {
  cleanup();
  window.matchMedia = originalMatchMedia;
  vi.useRealTimers();
});

describe("```flow blocks in chat", () => {
  it("draws all four parts of the reference spec and their rails", () => {
    const { container } = renderFlow(inlineDiscussions);
    const ids = [...container.querySelectorAll("[data-part-id]")].map((e) =>
      e.getAttribute("data-part-id")
    );
    expect(ids).toEqual(["you", "process", "tools", "events"]);
    const live = after.rails.filter((r) => r.presence !== "absent");
    expect(live.length).toBeGreaterThanOrEqual(5);
    expect(container.querySelectorAll(".md-wire")).toHaveLength(live.length);
    expect(screen.getByTestId("machine-diagram-viewport")).toBeInTheDocument();
  });

  it("renders a part kind registered only in this test, via the registry context", () => {
    const beacon: PartKindDef = {
      kind: "test beacon",
      job: "blinks",
      footprint: "L",
      bb: [260, 140, 120, 120],
      status: { x: 320, y: 290 },
      ports: {
        in: { side: "W", x: 260, y: 200, direction: "in", tokens: ["request"] },
      },
      verbs: {
        blink: {
          duration: 0.6,
          card: "required",
          compile({ t, out }) {
            out.note(t, "blinking", "green");
            return { consumed: true };
          },
        },
      },
    };
    const registry: FlowRegistry = createFlowRegistry();
    registry.parts.register(beacon);
    const spec = `
version: 1
parts:
  - { id: src, kind: source, position: { x: 0, y: 0 } }
  - { id: b, kind: test beacon, position: { x: 700, y: 0 } }
rails:
  - { id: wire, from: src.out, to: b.in }
cards:
  - { id: ping, token: request }
story:
  - caption: ping
    steps:
      - { verb: send, part: src, card: ping }
      - { verb: blink, part: b, card: ping, via: wire }
`;
    const { container } = renderFlow(spec, (n) => (
      <FlowRegistryContext.Provider value={registry}>
        {n}
      </FlowRegistryContext.Provider>
    ));
    expect(screen.queryByTestId("flow-errors")).toBeNull();
    const part = container.querySelector("[data-part-id='b']");
    expect(part).not.toBeNull();
    expect(part).toHaveAttribute("data-part", "test beacon");
  });

  it.each([
    [
      "malformed YAML",
      "version: 1\nparts: [\n  - { id: x",
      /invalid YAML at line \d+/,
    ],
    [
      "an unknown part kind",
      plainSpec.replace("kind: worker", "kind: wroker"),
      /parts\[1\]\.kind: unknown part kind "wroker" \(did you mean "worker"\?\); registered: .*worker/,
    ],
    [
      "a rail to a missing part",
      plainSpec.replace("to: w.in", "to: wk.in"),
      /rails\[0\]\.to: .*"wk".*\(did you mean "w"\?\)/,
    ],
  ])("shows the formatted error inline for %s", (_name, body, expected) => {
    expect(() => renderFlow(body)).not.toThrow();
    const errors = screen.getByTestId("flow-errors");
    expect(errors).toBeVisible();
    expect(errors.textContent).toMatch(expected);
    expect(screen.queryByTestId("flow-player")).toBeNull();
  });

  it("auto-lays out a spec without positions before playing it", async () => {
    renderFlow(plainSpec.replace(/, position: \{ x: \d+, y: 0 \}/g, ""));
    expect(screen.getByTestId("flow-laying-out")).toBeVisible();
    expect(screen.queryByTestId("flow-player")).toBeNull();
    expect(await screen.findByTestId("flow-player")).toBeVisible();
    expect(screen.queryByTestId("flow-laying-out")).toBeNull();
    const parts = [...document.querySelectorAll("[data-part-id]")].map((g) =>
      g.getAttribute("transform")
    );
    expect(parts).toHaveLength(2);
    expect(new Set(parts).size).toBe(2);
  });

  it("names the spec path for a rail pointing at a missing part in a later rail", () => {
    const body = plainSpec.replace(
      "rails:\n  - { id: jobs, from: src.out, to: w.in }",
      "rails:\n  - { id: jobs, from: src.out, to: w.in }\n  - { id: extra, from: src.out, to: ghost.in }"
    );
    renderFlow(body);
    const item = screen
      .getAllByRole("listitem")
      .find((li) => li.getAttribute("data-path")?.startsWith("rails[1].to"));
    expect(item?.textContent).toMatch(/^rails\[1\]\.to: /);
  });
});

describe("flow playback", () => {
  beforeEach(() => {
    vi.useFakeTimers({
      toFake: [
        "setTimeout",
        "clearTimeout",
        "setInterval",
        "clearInterval",
        "requestAnimationFrame",
        "cancelAnimationFrame",
        "performance",
        "Date",
      ],
    });
  });

  it("play advances t, pause holds it", () => {
    mockReducedMotion(false);
    renderFlow(inlineDiscussions);
    const start = shownT();
    expect(start).toBeCloseTo(afterOutcomes[0], 9);
    fireEvent.click(screen.getByRole("button", { name: "Play" }));
    act(() => vi.advanceTimersByTime(500));
    const playing = shownT();
    expect(playing).toBeGreaterThan(start + 0.3);
    fireEvent.click(screen.getByRole("button", { name: "Pause" }));
    act(() => vi.advanceTimersByTime(1000));
    expect(shownT()).toBe(playing);
  });

  it("steps land exactly on beat outcomes and wrap at both ends", () => {
    mockReducedMotion(false);
    renderFlow(inlineDiscussions);
    const next = screen.getByRole("button", { name: "Next beat" });
    const prev = screen.getByRole("button", { name: "Previous beat" });
    const n = after.beats.length;
    for (let i = 1; i < n; i++) {
      fireEvent.click(next);
      expect(shownT()).toBe(afterOutcomes[i]);
      expect(shownBeat()).toBe(i);
    }
    fireEvent.click(next);
    expect(shownT()).toBe(afterOutcomes[0]);
    fireEvent.click(prev);
    expect(shownT()).toBe(afterOutcomes[n - 1]);
    fireEvent.click(prev);
    expect(shownT()).toBe(afterOutcomes[n - 2]);
  });

  it("stepping while playing pauses on the next beat's outcome", () => {
    mockReducedMotion(false);
    renderFlow(inlineDiscussions);
    fireEvent.click(screen.getByRole("button", { name: "Play" }));
    act(() => vi.advanceTimersByTime(300));
    const showing = shownBeat();
    expect(shownT()).not.toBe(afterOutcomes[showing]);
    fireEvent.click(screen.getByRole("button", { name: "Next beat" }));
    expect(player()).toHaveAttribute("data-playing", "false");
    expect(shownT()).toBe(afterOutcomes[showing + 1]);
  });

  it("under reduced motion, play advances beat by beat and only shows outcomes", () => {
    mockReducedMotion(true);
    renderFlow(inlineDiscussions);
    fireEvent.click(screen.getByRole("button", { name: "Play" }));
    const seen = new Set<number>();
    const beats = new Set<number>();
    for (let i = 0; i < 1500; i++) {
      act(() => vi.advanceTimersByTime(16));
      seen.add(shownT());
      beats.add(shownBeat());
    }
    for (const t of seen) expect(afterOutcomes).toContain(t);
    expect(beats.size).toBeGreaterThanOrEqual(3);
  });

  it("shows the Before/After toggle only with two arrangements and keeps the story beat", () => {
    mockReducedMotion(false);
    renderFlow(plainSpec);
    expect(
      screen.queryByRole("radiogroup", { name: "Arrangement" })
    ).toBeNull();
    cleanup();

    renderFlow(inlineDiscussions);
    expect(
      screen.getByRole("radiogroup", { name: "Arrangement" })
    ).toBeInTheDocument();
    expect(player()).toHaveAttribute("data-arrangement", "after");
    const next = screen.getByRole("button", { name: "Next beat" });
    fireEvent.click(next);
    fireEvent.click(next);
    fireEvent.click(next);
    expect(shownBeat()).toBe(3);
    fireEvent.click(screen.getByRole("radio", { name: "Before" }));
    expect(player()).toHaveAttribute("data-arrangement", "before");
    // After's 4th beat (the denied edit) has no Before caption: Before
    // still shows Q2, its 3rd beat.
    expect(shownBeat()).toBe(2);
    expect(shownT()).toBe(beatOutcome(before.travel, 2));
  });
});

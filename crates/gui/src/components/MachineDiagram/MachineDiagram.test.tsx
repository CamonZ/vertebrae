import { Profiler } from "react";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import css from "./MachineDiagram.css?raw";
import {
  sourceFixture,
  twoPhaseFixture,
  workerFixture,
  type GalleryPartFixture,
} from "./__fixtures__/galleryParts";
import type { ChangeMark as Mark } from "./accessibility";
import { MachineDiagram } from "./MachineDiagram";
import { MachineDiagramViewport } from "./MachineDiagramViewport";
import { MachinePart, type PartView } from "./MachinePart";
import { Rail, Wire } from "./Rail";
import type { DiagramPose } from "./timeline";

function Part<E>({
  fixture,
  t,
  scenario = 0,
  view,
  pose,
  change,
  reducedMotion,
  labels,
}: {
  fixture: GalleryPartFixture<E>;
  t: number;
  scenario?: number;
  view?: PartView;
  pose?: Exclude<DiagramPose, "removed">;
  change?: Mark;
  reducedMotion?: boolean;
  labels?: boolean;
}) {
  const sc = fixture.scenarios[scenario];
  return (
    <MachineDiagram label={fixture.part.name} labels={labels}>
      <MachinePart
        part={fixture.part}
        bb={fixture.bb}
        timeline={sc.timeline}
        t={t}
        view={view ?? { kind: "scenario", name: sc.name }}
        pose={pose}
        change={change}
        status={fixture.status}
        reducedMotion={reducedMotion}
      >
        {(frame) => fixture.draw(frame.t, sc.extra)}
      </MachinePart>
    </MachineDiagram>
  );
}

/** Separate mounts get distinct useId hatch ids; everything else must match. */
const stable = (html: string) => html.replace(/md-hatch-[\w-]+/g, "md-hatch");

const markup = (
  t: number,
  fixture: GalleryPartFixture = workerFixture as GalleryPartFixture
) => {
  const { container, unmount } = render(
    <Part fixture={fixture} t={t} reducedMotion={false} />
  );
  const html = stable(container.innerHTML);
  unmount();
  return html;
};

afterEach(() => {
  document.documentElement.classList.remove("light");
});

describe("determinism (criterion 1)", () => {
  it("renders identical SVG for the same t", () => {
    for (const t of [0.8, 1.9, 2.95, 4.3]) expect(markup(t)).toBe(markup(t));
  });

  it("seeks backwards: re-rendering an earlier t equals a fresh render at that t", () => {
    const { container, rerender } = render(
      <Part fixture={workerFixture} t={3.1} reducedMotion={false} />
    );
    rerender(<Part fixture={workerFixture} t={0.95} reducedMotion={false} />);
    expect(stable(container.innerHTML)).toBe(markup(0.95));
  });

  it("draws the busiest gallery scenario deterministically", () => {
    expect(markup(1.77, twoPhaseFixture as GalleryPartFixture)).toBe(
      markup(1.77, twoPhaseFixture as GalleryPartFixture)
    );
  });
});

describe("theme (criterion 5)", () => {
  const COLOUR_LITERAL = /#[0-9a-f]{3,8}\b|rgba?\(|hsla?\(|oklch\(|oklab\(/i;

  it("emits no colour literals: every paint is a theme variable, none or a pattern", () => {
    for (const t of [0.8, 1.9, 2.95]) {
      const { container, unmount } = render(
        <Part fixture={twoPhaseFixture} t={t} reducedMotion={false} />
      );
      expect(container.innerHTML).not.toMatch(COLOUR_LITERAL);
      for (const el of container.querySelectorAll("[fill], [stroke]")) {
        for (const attr of ["fill", "stroke"]) {
          const v = el.getAttribute(attr);
          if (v == null) continue;
          expect(v).toMatch(
            /^(var\(--(md|fg|edge-color|step-route)[\w-]*\)|none|url\(#[\w-]+\)|color-mix\(in oklch, var\(--fg-mute\) 30%, transparent\))$/
          );
        }
      }
      unmount();
    }
  });

  it("switching light/dark neither changes the markup nor re-renders the timeline", () => {
    const onRender = vi.fn();
    const { container } = render(
      <Profiler id="diagram" onRender={onRender}>
        <Part fixture={workerFixture} t={1.9} reducedMotion={false} />
      </Profiler>
    );
    const before = container.innerHTML;
    const renders = onRender.mock.calls.length;
    act(() => document.documentElement.classList.add("light"));
    expect(container.innerHTML).toBe(before);
    expect(onRender.mock.calls.length).toBe(renders);
  });

  it("maps the catalogue roles onto the app tokens and the app monospace font", () => {
    const expected: Record<string, string> = {
      "--md-amber": "var(--color-warn)",
      "--md-amber-wash": "var(--color-warn-wash)",
      "--md-green": "var(--color-ok)",
      "--md-green-wash": "var(--color-ok-wash)",
      "--md-red": "var(--color-err)",
      "--md-red-wash": "var(--color-err-wash)",
      "--md-ink": "var(--color-fg)",
      "--md-dim": "var(--color-fg-mute)",
      "--md-edge": "var(--color-fg-faint)",
      "--md-ghost": "var(--color-fg-ghost)",
    };
    for (const [prop, value] of Object.entries(expected))
      expect(css).toContain(`${prop}: ${value};`);
    expect(css).toContain("font-family: var(--font-mono);");
    expect(css).not.toMatch(COLOUR_LITERAL);
    expect(css).not.toMatch(/Plex/i);
  });
});

describe("text", () => {
  it("is real, selectable SVG text never under 18 px", () => {
    const { container } = render(
      <Part fixture={twoPhaseFixture} t={3.6} reducedMotion={false} />
    );
    const texts = [...container.querySelectorAll("text")];
    expect(texts.length).toBeGreaterThan(3);
    for (const el of texts)
      expect(Number(el.getAttribute("font-size"))).toBeGreaterThanOrEqual(18);
    expect(container.textContent).toContain("all committed");
    expect(container.textContent).toContain("two-phase commit");
  });

  it("hides labels for the silhouette view", () => {
    const { container } = render(
      <Part
        fixture={workerFixture}
        t={1.9}
        labels={false}
        reducedMotion={false}
      />
    );
    expect(container.querySelectorAll("text")).toHaveLength(0);
  });
});

describe("accessibility and change marks", () => {
  it("names part, universal state and change mark", () => {
    render(
      <Part
        fixture={workerFixture}
        t={2.95}
        view={{ kind: "state", state: "ok" }}
        reducedMotion={false}
      />
    );
    expect(
      screen.getByRole("img", { name: "worker, ok, unchanged. runs one job." })
    ).toBeInTheDocument();
  });

  it("names the scenario view like the gallery", () => {
    render(
      <Part
        fixture={sourceFixture}
        t={1}
        change="added"
        reducedMotion={false}
      />
    );
    expect(
      screen.getByRole("img", {
        name: "source: emits work. Scenario: sends. added. Also person · trigger · scheduler · watcher.",
      })
    ).toBeInTheDocument();
  });

  it.each([
    ["added", "+ added"],
    ["changed", "~ changed"],
  ] as const)(
    "draws the %s mark with its tab and keeps the part running",
    (change, tab) => {
      const { container } = render(
        <Part
          fixture={workerFixture}
          t={1.9}
          change={change}
          reducedMotion={false}
        />
      );
      expect(container.querySelector(`[data-mark="${change}"]`)).not.toBeNull();
      expect(container.textContent).toContain(tab);
      expect(container.querySelectorAll(".md-card").length).toBeGreaterThan(0);
    }
  );

  it("removed: ghosted and hatched, dashed rails, no cards, status says so", () => {
    const { container } = render(
      <Part
        fixture={workerFixture}
        t={1.9}
        change="removed"
        reducedMotion={false}
      />
    );
    expect(container.querySelector('[data-mark="removed"]')).not.toBeNull();
    expect(
      container.querySelector(".md-ghost .md-hatch[clip-path^='url(#']")
    ).not.toBeNull();
    expect(container.querySelectorAll(".md-card")).toHaveLength(0);
    expect(
      container.querySelectorAll(".md-rail .gedge.k-handoff")
    ).toHaveLength(2);
    expect(container.textContent).toContain("removed in this change");
    expect(
      screen.getByRole("img", { name: /worker: runs one job\. .* removed\./ })
    ).toBeInTheDocument();
  });

  it("absent: no instance, ghosted, no change tab", () => {
    const { container } = render(
      <Part
        fixture={workerFixture}
        t={1.9}
        pose="absent"
        view={{ kind: "state", state: "absent" }}
        reducedMotion={false}
      />
    );
    expect(container.querySelector(".md-ghost")).not.toBeNull();
    expect(container.querySelector(".md-change")).toBeNull();
    expect(container.textContent).toContain("absent · no instance");
  });
});

describe("reduced motion", () => {
  it("follows prefers-reduced-motion and renders the beat outcome without interpolation", () => {
    const original = window.matchMedia;
    window.matchMedia = vi.fn().mockImplementation((query: string) => ({
      matches: query.includes("reduce"),
      media: query,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    })) as unknown as typeof window.matchMedia;
    try {
      const early = render(<Part fixture={workerFixture} t={1.36} />);
      const html = stable(early.container.innerHTML);
      early.unmount();
      const late = render(<Part fixture={workerFixture} t={2.5} />);
      expect(stable(late.container.innerHTML)).toBe(html);
      // no smear ghosts: each card draws only its body
      expect(late.container.querySelectorAll(".md-card > rect")).toHaveLength(
        0
      );
      expect(late.container.querySelectorAll(".md-status text")).toHaveLength(
        1
      );
    } finally {
      window.matchMedia = original;
    }
  });
});

describe("rails and wires", () => {
  it("draws rails through the shared GraphEdge path without arrowheads", () => {
    const { container } = render(
      <MachineDiagram label="rails">
        <Rail
          points={[
            [0, 0],
            [100, 0],
            [100, 100],
          ]}
        />
        <Rail
          points={[
            [0, 50],
            [100, 50],
          ]}
          dashed
          dash="4 6"
        />
      </MachineDiagram>
    );
    const paths = container.querySelectorAll(".md-rail path.gedge");
    expect(paths).toHaveLength(2);
    expect(paths[0].getAttribute("marker-end")).toBeNull();
    expect(paths[0].getAttribute("d")).toMatch(/^M0 0 L78 0 /);
    expect(paths[1].getAttribute("class")).toContain("k-handoff");
    expect(
      (paths[1].parentElement as HTMLElement).style.getPropertyValue(
        "--md-dash"
      )
    ).toBe("4 6");
  });

  it("marks new and removed wires with + and × glyphs; arrows reuse GraphMarkers", () => {
    const { container } = render(
      <MachineDiagram label="wires">
        <Wire
          points={[
            [0, 0],
            [40, 0],
          ]}
          change="added"
          arrow
        />
        <Wire
          points={[
            [0, 50],
            [40, 50],
          ]}
          change="removed"
        />
        <Wire
          points={[
            [0, 90],
            [40, 90],
          ]}
          label="more tool calls"
        />
      </MachineDiagram>
    );
    expect(container.querySelector("marker#ge-arrow")).not.toBeNull();
    const [added, removed, plain] = container.querySelectorAll(".md-wire");
    expect(added.textContent).toBe("+");
    expect(added.querySelector("path")?.getAttribute("marker-end")).toBe(
      "url(#ge-arrow)"
    );
    expect(removed.textContent).toBe("×");
    expect(plain.textContent).toBe("more tool calls");
  });
});

describe("viewport", () => {
  it("pans and zooms with the shared controls and keeps wire labels as DOM text", () => {
    render(
      <MachineDiagramViewport
        width={640}
        height={400}
        labels={[{ id: "a", labels: ["retry", "deny"], x: 300, y: 120 }]}
      >
        <Part fixture={workerFixture} t={1.9} reducedMotion={false} />
      </MachineDiagramViewport>
    );
    const stage = screen
      .getByTestId("machine-diagram-viewport")
      .querySelector(".md-stage") as HTMLElement;
    expect(stage.style.transform).toContain("scale(1)");
    fireEvent.click(screen.getByRole("button", { name: "Zoom in" }));
    expect(stage.style.transform).toContain("scale(1.25)");
    fireEvent.click(screen.getByRole("button", { name: "Zoom out" }));
    expect(stage.style.transform).toContain("scale(1)");
    expect(
      screen.getByRole("button", { name: "Fit to view" })
    ).toBeInTheDocument();
    expect(screen.getByText("retry +1")).toBeInTheDocument();
  });

  function gestureViewport() {
    render(
      <MachineDiagramViewport width={640} height={400}>
        <Part fixture={workerFixture} t={1.9} reducedMotion={false} />
      </MachineDiagramViewport>
    );
    const viewport = screen.getByTestId("machine-diagram-viewport");
    const canvas = viewport.firstElementChild as HTMLElement;
    const stage = viewport.querySelector(".md-stage") as HTMLElement;
    // The stage sits at (100, 200) on screen, shifted by its own translate.
    vi.spyOn(stage, "getBoundingClientRect").mockImplementation(() => {
      const [x, y] = stage.style.transform
        .match(/-?\d+(?:\.\d+)?(?:e[+-]?\d+)?/g)!
        .map(Number);
      return { left: 100 + x, top: 200 + y } as DOMRect;
    });
    const zoom = () => Number(stage.dataset.zoom);
    /** The diagram point under screen point (300, 300). */
    const under = () => {
      const b = stage.getBoundingClientRect();
      return [(300 - b.left) / zoom(), (300 - b.top) / zoom()];
    };
    return { canvas, zoom, under };
  }

  function wheel(target: HTMLElement, deltaY: number, ctrlKey: boolean) {
    const event = new WheelEvent("wheel", {
      bubbles: true,
      cancelable: true,
      ctrlKey,
      deltaY,
      clientX: 300,
      clientY: 300,
    });
    fireEvent(target, event);
    return event;
  }

  it("zooms on Ctrl/⌘-wheel and trackpad pinch around the pointer", () => {
    const { canvas, zoom, under } = gestureViewport();
    const before = under();
    let event!: WheelEvent;
    act(() => {
      event = wheel(canvas, -100, true);
    });
    expect(event.defaultPrevented).toBe(true);
    expect(zoom()).toBeCloseTo(Math.exp(0.2));
    expect(under()[0]).toBeCloseTo(before[0]);
    expect(under()[1]).toBeCloseTo(before[1]);
  });

  it("zooms on WebKit gesture events (Safari/WKWebView pinch)", () => {
    const { canvas, zoom, under } = gestureViewport();
    const before = under();
    const gesture = (type: string, scale: number) => {
      const event = Object.assign(
        new Event(type, { bubbles: true, cancelable: true }),
        { scale, clientX: 300, clientY: 300 }
      );
      fireEvent(canvas, event);
    };
    act(() => {
      gesture("gesturestart", 1);
      gesture("gesturechange", 1.5);
      gesture("gestureend", 2);
    });
    expect(zoom()).toBeCloseTo(2);
    expect(under()[0]).toBeCloseTo(before[0]);
    expect(under()[1]).toBeCloseTo(before[1]);
  });

  it("leaves plain wheel scrolling to the page", () => {
    const { canvas, zoom } = gestureViewport();
    let event!: WheelEvent;
    act(() => {
      event = wheel(canvas, -100, false);
    });
    expect(event.defaultPrevented).toBe(false);
    expect(zoom()).toBe(1);
  });
});

describe("resizable viewport", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  /** A resizable viewport fitted into a 662px-wide frame (600px after the gutter). */
  function resizable() {
    vi.stubGlobal(
      "PointerEvent",
      class extends MouseEvent {
        pointerId: number;
        isPrimary: boolean;
        constructor(type: string, options: PointerEventInit = {}) {
          super(type, options);
          this.pointerId = options.pointerId ?? 1;
          this.isPrimary = options.isPrimary ?? true;
        }
      }
    );
    vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockReturnValue(
      600 + 62
    );
    render(
      <MachineDiagramViewport
        width={1200}
        height={400}
        fitOnMount
        resizeLabel="Resize diagram"
        minHeight={160}
      >
        <Part fixture={workerFixture} t={1.9} reducedMotion={false} />
      </MachineDiagramViewport>
    );
    const frame = screen.getByTestId("machine-diagram-viewport");
    const grip = screen.getByRole("separator", { name: "Resize diagram" });
    // jsdom has no pointer capture.
    Object.assign(grip, {
      setPointerCapture: () => {},
      hasPointerCapture: () => false,
      releasePointerCapture: () => {},
    });
    const stage = frame.querySelector(".md-stage") as HTMLElement;
    // jsdom has no layout: the frame reports its styled height.
    vi.spyOn(frame, "getBoundingClientRect").mockImplementation(
      () => ({ height: parseFloat(frame.style.height) }) as DOMRect
    );
    return { frame, grip, stage, height: () => frame.style.height };
  }

  it("starts at the fitted height; the first drag on the grip replaces it", () => {
    const { frame, grip, stage, height } = resizable();
    // Fitted at 600/1200 = 0.5 → 200px (above the 160px minimum).
    expect(height()).toBe("200px");
    expect(grip).toHaveAttribute("aria-valuemin", "160");
    expect(grip).toHaveAttribute("aria-valuenow", "200");
    const transform = stage.style.transform;
    fireEvent.pointerDown(grip, { button: 0, clientX: 10, clientY: 300 });
    fireEvent.pointerMove(grip, { clientX: 10, clientY: 380 });
    fireEvent.pointerUp(grip, { clientX: 10, clientY: 380 });
    expect(height()).toBe("280px");
    expect(grip).toHaveAttribute("aria-valuenow", "280");
    // Zoom and pan stay anchored at the frame's top-left.
    expect(stage.style.transform).toBe(transform);
    expect(frame).toHaveAttribute("data-dragging", "false");
  });

  it("Up/Down on the focused grip resize within the bounds", () => {
    const { grip, stage, height } = resizable();
    const transform = stage.style.transform;
    act(() => grip.focus());
    fireEvent.keyDown(grip, { key: "ArrowDown" });
    expect(height()).toBe("224px");
    fireEvent.keyDown(grip, { key: "ArrowUp", shiftKey: true });
    expect(height()).toBe("176px");
    for (let i = 0; i < 10; i++) fireEvent.keyDown(grip, { key: "ArrowUp" });
    expect(height()).toBe(`${grip.getAttribute("aria-valuemin")}px`);
    for (let i = 0; i < 40; i++)
      fireEvent.keyDown(grip, { key: "ArrowDown", shiftKey: true });
    expect(height()).toBe(`${grip.getAttribute("aria-valuemax")}px`);
    expect(stage.style.transform).toBe(transform);
  });

  it("never fits below the minimum height", () => {
    vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockReturnValue(
      600 + 62
    );
    render(
      <MachineDiagramViewport
        width={1200}
        height={400}
        fitOnMount
        minHeight={320}
      >
        <Part fixture={workerFixture} t={1.9} reducedMotion={false} />
      </MachineDiagramViewport>
    );
    expect(screen.getByTestId("machine-diagram-viewport").style.height).toBe(
      "320px"
    );
  });

  it("fits clear of floating panels and gives them a layer in the frame", () => {
    vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockReturnValue(
      600 + 62 + 300
    );
    let layer: HTMLElement | null = null;
    render(
      <MachineDiagramViewport
        width={1200}
        height={400}
        fitOnMount
        overlayRef={(el) => (layer = el)}
        fitInsets={() => ({ right: 300, bottom: 50 })}
      >
        <Part fixture={workerFixture} t={1.9} reducedMotion={false} />
      </MachineDiagramViewport>
    );
    const frame = screen.getByTestId("machine-diagram-viewport");
    const stage = frame.querySelector(".md-stage") as HTMLElement;
    expect(stage.dataset.zoom).toBe("0.5");
    expect(frame.style.height).toBe(`${200 + 50}px`);
    expect(layer).not.toBeNull();
    expect(frame).toContainElement(layer);
  });

  it("has no grip unless asked for one", () => {
    render(
      <MachineDiagramViewport width={640} height={400}>
        <Part fixture={workerFixture} t={1.9} reducedMotion={false} />
      </MachineDiagramViewport>
    );
    expect(screen.queryByRole("separator")).toBeNull();
  });
});

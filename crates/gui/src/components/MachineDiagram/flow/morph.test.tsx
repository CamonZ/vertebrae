import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PortMark, StageMark } from "../ChangeMark";
import { hatchPath } from "../hatch";
import { MachineDiagram } from "../MachineDiagram";
import inlineDiscussions from "./__fixtures__/inlineDiscussions.flow.yaml?raw";
import { FlowPlayer } from "./FlowPlayer";
import {
  arrangement,
  compileFlow,
  compileFlowOrThrow,
  parseFlowSpec,
  type CompiledFlow,
} from "./index";
import type { Presence } from "./compile";
import { MORPH_SECONDS, morphLayers, partDiffers, railDiffers } from "./morph";

/** One PR touching every kind of mark: parts, wires, ports, stages and steps. */
const spec = {
  version: 1,
  title: "every mark",
  parts: [
    { id: "src", kind: "source" },
    {
      id: "w",
      kind: "worker",
      change: "changed",
      changeNote: "retries on crash",
      portChanges: { ctl: "added", out: "changed" },
    },
    { id: "q", kind: "queue", change: "added" },
    { id: "st", kind: "store", change: "removed" },
    {
      id: "pipe",
      kind: "pipeline",
      stageChanges: { build: "added", test: "changed", ship: "removed" },
    },
  ],
  rails: [
    { id: "r1", from: "src.out", to: "w.in" },
    { id: "r2", from: "src.out", to: "q.in", change: "added" },
    { id: "r3", from: "src.out", to: "st.in", change: "removed" },
  ],
  cards: [
    { id: "c1", token: "request", origin: "src" },
    { id: "c2", token: "data", origin: "src" },
    { id: "c3", token: "data", origin: "src" },
    { id: "c4", token: "payload" },
  ],
  story: [
    {
      id: "b1",
      caption: "a job arrives",
      steps: [
        { verb: "send", part: "src", card: "c1" },
        { verb: "stage", part: "w", card: "c1", via: "r1" },
      ],
    },
    {
      id: "b2",
      caption: "it finishes",
      steps: [{ verb: "finish", part: "w", card: "c1", change: "changed" }],
    },
    {
      id: "b3",
      caption: "queued now",
      steps: [
        { verb: "send", part: "src", card: "c2" },
        { verb: "send", part: "q", card: "c2", via: "r2" },
      ],
    },
    {
      id: "b4",
      caption: "stored before",
      steps: [
        { verb: "send", part: "src", card: "c3", change: "removed" },
        {
          verb: "record",
          part: "st",
          card: "c3",
          via: "r3",
          change: "removed",
        },
      ],
    },
    {
      id: "b5",
      caption: "the pipeline",
      steps: [{ verb: "stage", part: "pipe", card: "c4", change: "added" }],
    },
  ],
};

const flow = compileFlowOrThrow(spec);
const before = arrangement(flow, "before")!;
const after = arrangement(flow, "after")!;

const fixture = (() => {
  const p = parseFlowSpec(inlineDiscussions);
  if (!p.ok) throw new Error("fixture does not parse");
  return compileFlowOrThrow(p.value);
})();

const player = () => screen.getByTestId("flow-player");
const key = (k: string) =>
  fireEvent.keyDown(document.activeElement ?? player(), { key: k });
const fakeFrames = () =>
  vi.useFakeTimers({
    toFake: ["requestAnimationFrame", "cancelAnimationFrame", "performance"],
  });
const frame = (ms = 16) => act(() => vi.advanceTimersByTime(ms));

function renderPlayer(f: CompiledFlow, reducedMotion: boolean) {
  render(<FlowPlayer flow={f} reducedMotion={reducedMotion} />);
  act(() => player().focus());
}

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("morph layers", () => {
  const live: { presence: Presence } = { presence: "live" };
  const gone: { presence: Presence } = { presence: "absent" };
  const differ = () => true;
  const alike = () => false;

  it("draws an unchanged element once, opaque, at every progress", () => {
    for (const e of [undefined, 0, 0.5, 1])
      expect(morphLayers(live, live, e, alike)).toEqual({
        to: 1,
        morphing: false,
      });
  });

  it("an arriving element fades in; a leaving one fades out over it", () => {
    expect(morphLayers(live, gone, 0.25, differ)).toEqual({
      to: 0.25,
      morphing: true,
    });
    expect(morphLayers(gone, live, 0.25, differ)).toEqual({
      from: 0.75,
      morphing: true,
    });
    // Changed in place: the arriving copy stays opaque under the leaving one.
    expect(morphLayers(live, live, 0.25, differ)).toEqual({
      to: 1,
      from: 0.75,
      morphing: true,
    });
  });

  it("a rail blends only when its mark or presence differs", () => {
    const differs = (id: string) =>
      railDiffers(
        before.rails.find((r) => r.id === id)!,
        after.rails.find((r) => r.id === id)!
      );
    expect(differs("r1")).toBe(false);
    expect(differs("r2")).toBe(true);
    expect(differs("r3")).toBe(true);
  });

  it("settles on the arriving element", () => {
    expect(morphLayers(live, live, 1, differ)).toEqual({
      to: 1,
      morphing: false,
    });
    expect(morphLayers(gone, live, 1, differ)).toEqual({ morphing: false });
  });
});

describe("compiled marks", () => {
  it("only marks make two arrangements", () => {
    const one = compileFlowOrThrow({
      version: 1,
      parts: [{ id: "w", kind: "worker", portChanges: { ctl: "unchanged" } }],
    });
    expect(one.arrangements.map((a) => a.arrangement)).toEqual(["current"]);
    for (const extra of [
      { portChanges: { ctl: "added" } },
      { kind: "pipeline", stageChanges: { test: "changed" } },
    ]) {
      const two = compileFlowOrThrow({
        version: 1,
        parts: [{ id: "w", kind: "worker", ...extra }],
      });
      expect(two.arrangements.map((a) => a.arrangement)).toEqual([
        "before",
        "after",
      ]);
    }
    const steps = compileFlowOrThrow({
      version: 1,
      parts: [{ id: "w", kind: "worker" }],
      cards: [{ id: "c", token: "request" }],
      story: [
        { steps: [{ verb: "stage", part: "w", card: "c", change: "added" }] },
      ],
    });
    expect(steps.arrangements).toHaveLength(2);
  });

  it("port and stage marks are drawn in After only", () => {
    const w = (d: typeof after) => d.parts.find((p) => p.id === "w")!;
    const pipe = (d: typeof after) => d.parts.find((p) => p.id === "pipe")!;
    expect(w(after).portChanges).toEqual({ ctl: "added", out: "changed" });
    expect(w(before).portChanges).toEqual({});
    expect(pipe(after).stageMarks.map((s) => [s.name, s.change])).toEqual([
      ["build", "added"],
      ["test", "changed"],
      ["ship", "removed"],
    ]);
    expect(pipe(before).stageMarks).toEqual([]);
  });

  it("an added step runs only in After, a removed one only in Before", () => {
    const verbs = (d: typeof after, id: string) =>
      d.parts.find((p) => p.id === id)!.steps.map((s) => s.verb);
    expect(verbs(after, "pipe")).toEqual(["stage"]);
    expect(verbs(before, "pipe")).toEqual([]);
    expect(verbs(before, "st")).toEqual(["record"]);
    expect(verbs(after, "st")).toEqual([]);
    // Changed steps run in both.
    expect(verbs(before, "w")).toContain("finish");
    expect(verbs(after, "w")).toContain("finish");
  });

  it("lists marked steps on their beats in After", () => {
    const byCaption = (d: typeof after) =>
      Object.fromEntries(
        d.beats.map((b) => [
          b.caption,
          b.changes.map((c) => `${c.change} ${c.label}`),
        ])
      );
    expect(byCaption(after)).toMatchObject({
      "a job arrives": [],
      "it finishes": ["changed worker · finish"],
      "stored before": ["removed source · send", "removed store · record"],
      "the pipeline": ["added pipeline · stage"],
    });
    expect(before.beats.every((b) => b.changes.length === 0)).toBe(true);
  });

  it("rejects marks on ports and stages the part does not have", () => {
    const r = compileFlow({
      version: 1,
      parts: [
        {
          id: "w",
          kind: "worker",
          portChanges: { side: "added", ctl: "bent" },
        },
        { id: "s", kind: "store", stageChanges: { x: "added" } },
        { id: "p", kind: "pipeline", stageChanges: { deploy: "added" } },
      ],
      cards: [{ id: "c", token: "request" }],
      story: [
        { steps: [{ verb: "stage", part: "w", card: "c", change: "new" }] },
      ],
    });
    expect(r.ok).toBe(false);
    const errs = r.ok ? [] : r.errors.map((e) => `${e.path}: ${e.message}`);
    expect(errs.join("\n")).toMatch(
      /parts\[0\]\.portChanges\.side: worker has no port "side"/
    );
    expect(errs.join("\n")).toMatch(
      /parts\[0\]\.portChanges\.ctl: unknown change mark "bent"/
    );
    expect(errs.join("\n")).toMatch(
      /parts\[1\]\.stageChanges: store has no stages to mark/
    );
    expect(errs.join("\n")).toMatch(
      /parts\[2\]\.stageChanges\.deploy: pipeline has no stage "deploy"/
    );
    expect(errs.join("\n")).toMatch(
      /steps\[0\]\.change: unknown change mark "new"/
    );
  });

  it("stage names follow the After props", () => {
    const r = compileFlow({
      version: 1,
      parts: [
        {
          id: "p",
          kind: "pipeline",
          change: "changed",
          props: { stages: ["build", "test"] },
          after: { props: { stages: ["build", "lint", "test"] } },
          stageChanges: { lint: "added" },
        },
      ],
    });
    expect(r.ok).toBe(true);
  });
});

/** Every element of the picture by its id, and whether it is part of a blend. */
function snapshotParts() {
  const root = player();
  return Object.fromEntries(
    [...root.querySelectorAll<SVGGElement>("[data-part-id]")].map((g) => [
      g.dataset.partId!,
      {
        transform: g.getAttribute("transform"),
        blended: g.closest("[data-morph-to],[data-morph-from]") !== null,
      },
    ])
  );
}

const leaving = () =>
  [...player().querySelectorAll<SVGGElement>("[data-morph-from]")].map((g) =>
    Number(g.getAttribute("opacity"))
  );

describe("Before/After morph", () => {
  for (const [name, f] of [
    ["the every-mark spec", flow],
    ["the inline-discussions fixture", fixture],
  ] as const) {
    it(`toggling at any beat keeps unchanged parts still and morphs only marked ones (${name})`, () => {
      fakeFrames();
      renderPlayer(f, false);
      const [b, a] = [arrangement(f, "before")!, arrangement(f, "after")!];
      const marked = a.parts
        .filter((p) => partDiffers(p, b.parts.find((q) => q.id === p.id)!))
        .map((p) => p.id);
      const unchanged = a.parts
        .map((p) => p.id)
        .filter((id) => !marked.includes(id));
      expect(marked.length).toBeGreaterThan(0);
      expect(unchanged.length).toBeGreaterThan(0);
      const beats = a.beats.length;
      for (let i = 0; i < beats; i++) {
        act(() => key("End")); // settle anywhere, then seek to beat i
        fireEvent.click(
          within(screen.getByTestId("flow-chapters")).getAllByRole("button")[i]
        );
        act(() => key(" ")); // pause where the chapter is
        if (player().dataset.playing === "true") key(" ");
        const settled = snapshotParts();
        key("b");
        expect(player().dataset.morph).toMatch(/→/);
        frame(MORPH_SECONDS * 500); // halfway
        const mid = snapshotParts();
        for (const id of unchanged) {
          if (!settled[id] && !mid[id]) continue; // absent in both
          // Drawn once, unblended, exactly where it was.
          expect(
            player().querySelectorAll(`[data-part-id='${id}']`)
          ).toHaveLength(1);
          expect(mid[id]).toEqual({ ...settled[id], blended: false });
        }
        // Marked parts blend: some layer between transparent and opaque.
        const opacities = leaving();
        expect(opacities.length).toBeGreaterThan(0);
        expect(opacities.every((o) => o > 0 && o < 1)).toBe(true);
        frame(MORPH_SECONDS * 1000);
        expect(player().dataset.morph).toBeUndefined();
        expect(leaving()).toEqual([]);
        expect(player().querySelectorAll("[data-morph-to]")).toHaveLength(0);
        // Back again for the next beat, settled.
        key("b");
        frame(MORPH_SECONDS * 1000 + 50);
      }
    });
  }

  it("added parts draw in, removed ones ghost out, changed ones flare", () => {
    fakeFrames();
    renderPlayer(flow, false);
    key("b"); // After → Before, settle
    frame(1000);
    expect(player().dataset.arrangement).toBe("before");
    key("b"); // Before → After
    frame(MORPH_SECONDS * 250);
    const q = player().querySelector("[data-part-id='q']")!;
    // The added queue fades in and its + outline draws on.
    const fading = q.closest("[data-morph-to]")!;
    expect(Number(fading.getAttribute("opacity"))).toBeGreaterThan(0);
    expect(Number(fading.getAttribute("opacity"))).toBeLessThan(1);
    const outline = q.querySelector('[data-mark="added"] rect')!;
    expect(outline.getAttribute("pathLength")).toBe("1");
    expect(Number(outline.getAttribute("stroke-dashoffset"))).toBeGreaterThan(
      0
    );
    // The removed store is ghosted underneath its live copy fading out.
    const st = player().querySelector("[data-part-id='st']")!;
    expect(st.getAttribute("data-pose")).toBe("removed");
    const live = [
      ...player().querySelectorAll("[data-morph-from] .md-part"),
    ].map((g) => g.getAttribute("data-pose"));
    expect(live).toContain("live");
    // The changed worker's brackets flare out from the frame.
    const brackets = player().querySelector(
      "[data-part-id='w'] .md-change[data-mark='changed'] path"
    )!;
    expect(Number(brackets.getAttribute("stroke-width"))).toBeGreaterThan(3.5);
    frame(1000);
    expect(
      player()
        .querySelector(
          "[data-part-id='w'] .md-change[data-mark='changed'] path"
        )!
        .getAttribute("stroke-width")
    ).toBe("3.5");
  });

  it("the leaving copies take no input and are hidden from assistive tech", () => {
    fakeFrames();
    renderPlayer(flow, false);
    key("b");
    frame(MORPH_SECONDS * 500);
    const from = [...player().querySelectorAll("[data-morph-from]")];
    expect(from.length).toBeGreaterThan(0);
    for (const g of from) {
      expect(g).toHaveAttribute("aria-hidden", "true");
      expect(g).toHaveAttribute("pointer-events", "none");
      expect(g.querySelector("[data-part-id]")).toBeNull();
      expect(g.querySelector("[tabindex]")).toBeNull();
    }
  });

  it("the band keeps its divider and frame still; rows and meter cross-fade", () => {
    fakeFrames();
    renderPlayer(fixture, false);
    const band = () => screen.getByTestId("flow-band");
    const divider = band().querySelector("rect")!.outerHTML;
    act(() => key("End"));
    key("b");
    frame(MORPH_SECONDS * 500);
    expect(band().querySelector("rect")!.outerHTML).toBe(divider);
    // One meter for tests and state; the leaving one fades over it.
    expect(screen.getAllByTestId("flow-band-meter")).toHaveLength(1);
    const from = band().querySelectorAll("[data-morph-from]");
    expect(from.length).toBeGreaterThan(0);
    frame(1000);
    expect(band().querySelectorAll("[data-morph-from]")).toHaveLength(0);
  });

  it("under reduced motion the toggle snaps to the settled arrangement", () => {
    fakeFrames();
    renderPlayer(flow, true);
    // Clip ids come from useId, so a remount renames them; nothing else may differ.
    const picture = () =>
      player()
        .querySelector("svg")!
        .innerHTML.replace(/md-(hatch|stage)-[\w-]+/g, "id");
    const settledAfter = picture();
    key("b");
    expect(player().dataset.arrangement).toBe("before");
    expect(player().dataset.morph).toBeUndefined();
    expect(
      player().querySelectorAll("[data-morph-from],[data-morph-to]")
    ).toHaveLength(0);
    // The segmented control snaps too, and back is exactly the settled After.
    fireEvent.click(screen.getByRole("radio", { name: "After" }));
    expect(player().dataset.morph).toBeUndefined();
    expect(picture()).toBe(settledAfter);
    frame(100);
    expect(player().querySelectorAll("[data-morph-from]")).toHaveLength(0);
  });

  it("a toggle mid-morph starts again from the arrangement showing", () => {
    fakeFrames();
    renderPlayer(flow, false);
    key("b");
    frame(MORPH_SECONDS * 300);
    key("b");
    expect(player().dataset.morph).toBe("before→after");
    frame(MORPH_SECONDS * 1000 + 50);
    expect(player().dataset.morph).toBeUndefined();
    expect(player().dataset.arrangement).toBe("after");
  });
});

describe("marks read without colour", () => {
  const MARKS = ["added", "changed", "removed"] as const;

  /** What tells marks apart once colour is removed: glyph and line style. */
  function signature(el: Element) {
    const strokes = [...el.querySelectorAll("rect, circle, path")]
      .filter((s) => s.closest(".md-change-glyph") === null)
      .map(
        (s) =>
          `${s.tagName}:${s.getAttribute("stroke-width")}:${s.getAttribute("stroke-dasharray") ?? "solid"}`
      );
    const glyph = el.querySelector(".md-change-glyph")!;
    const pill = glyph.querySelector("rect")!;
    return {
      glyph: glyph.textContent,
      lines: strokes.join(" "),
      tag: `${pill.getAttribute("stroke-dasharray") ?? "solid"}:${pill.getAttribute("stroke") ? "outline" : "fill"}`,
    };
  }

  it("port marks differ by glyph and line style", () => {
    const sigs = MARKS.map((m) => {
      const { container } = render(
        <MachineDiagram label="port">
          <PortMark mark={m} name="ctl" x={320} y={105} side="N" />
        </MachineDiagram>
      );
      const s = signature(container.querySelector(".md-port-mark")!);
      cleanup();
      return s;
    });
    expect(sigs.map((s) => s.glyph)).toEqual(["+ ctl", "~ ctl", "− ctl"]);
    expect(new Set(sigs.map((s) => s.lines)).size).toBe(3);
    expect(new Set(sigs.map((s) => s.tag)).size).toBe(3);
  });

  it("stage marks differ by glyph and line style", () => {
    const sigs = MARKS.map((m) => {
      const { container } = render(
        <MachineDiagram label="stage">
          <StageMark
            mark={m}
            name="test"
            bb={[248, 133, 144, 134]}
            tag={[272, 156]}
          />
        </MachineDiagram>
      );
      const s = signature(container.querySelector(".md-stage-mark")!);
      cleanup();
      return s;
    });
    expect(sigs.map((s) => s.glyph)).toEqual(["+", "~", "−"]);
    expect(new Set(sigs.map((s) => s.lines)).size).toBe(3);
    expect(new Set(sigs.map((s) => s.tag)).size).toBe(3);
  });

  it("marks use ink and grey only, so colour still means state", () => {
    const { container } = render(<FlowPlayer flow={flow} reducedMotion />);
    const marks = container.querySelectorAll(
      ".md-port-mark, .md-stage-mark, .md-change"
    );
    expect(marks.length).toBeGreaterThan(0);
    const colours = new Set(
      [...marks].flatMap((m) =>
        [...m.querySelectorAll("[stroke],[fill]")].flatMap((e) =>
          [e.getAttribute("stroke"), e.getAttribute("fill")].filter(
            (c): c is string => !!c && c !== "none" && !c.startsWith("url(")
          )
        )
      )
    );
    for (const c of colours) expect(c).toMatch(/--md-(ink|edge|bg|dim)\b/);
  });

  it("story-step marks differ by glyph and border style in the chapters", () => {
    render(<FlowPlayer flow={flow} reducedMotion />);
    const tags = within(screen.getByTestId("flow-chapters")).getAllByText(
      /^[+~−] /
    );
    const byMark = Object.fromEntries(
      tags.map((t) => [t.dataset.mark, t.className])
    );
    expect(Object.keys(byMark).sort()).toEqual(["added", "changed", "removed"]);
    expect(byMark.removed).toMatch(/border-dashed/);
    expect(byMark.removed).toMatch(/line-through/);
    expect(byMark.added).toMatch(/bg-fg/);
    expect(byMark.changed).not.toMatch(/border-dashed|bg-fg/);
    expect(
      screen.getByRole("button", {
        name: /Beat 4 of 5: stored before\. Changed steps: removed source · send; removed store · record/,
      })
    ).toBeInTheDocument();
  });
});

describe("ghost hatch", () => {
  it("anchors 45° lines every 16 px to the frame, as the gallery draws them", () => {
    for (const bb of [
      [80, 125, 480, 150],
      [210, 95, 220, 190],
      [3, 7, 50, 30],
    ] as const) {
      const segs = [
        ...hatchPath(bb).matchAll(
          /M(-?[\d.]+) (-?[\d.]+) L(-?[\d.]+) (-?[\d.]+)/g
        ),
      ].map((m) => m.slice(1).map(Number));
      const [x, y, w, h] = bb;
      // Gallery: for d from -(h+16) while d < w+16, step 16.
      expect(segs).toHaveLength(Math.ceil((w + 16 + h + 16) / 16));
      for (const [x0, y0, x1, y1] of segs) {
        expect(y0).toBe(y + h + 8);
        expect(y1).toBe(y - 8);
        expect(x1 - x0).toBe(h + 16); // 45°
        // Phase follows the frame: every line has x + y ≡ frame x + y (mod 16).
        expect((((x0 + y0 - (x + y)) % 16) + 16) % 16).toBe(0);
      }
      expect(segs[0][0]).toBe(x - 8 - (h + 16));
    }
  });
});

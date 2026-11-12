import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import inlineDiscussions from "../MachineDiagram/flow/__fixtures__/inlineDiscussions.flow.yaml?raw";
import { parseFlowSpec } from "../MachineDiagram/flow";
import { DRILL_HINT } from "../MachineDiagram/flow/FlowDiagram";
import type { Artifact } from "../../bindings";
import { queryClient } from "../../query/queryClient";
import { resetProjectScopedStores } from "../../stores/projectScopedStores";
import { FlowSpecView } from "./FlowSpecView";

const list = vi.hoisted(() => vi.fn());
vi.mock("../../bindings", () => ({
  commands: { listArtifactPresentations: list },
}));

const ARTIFACT_ID = "5bcac569-0000-4000-8000-000000000001";

/** A small sub-spec with its own Before/After (the worker is added). */
const inner = {
  version: 1,
  title: "Inside the session",
  parts: [
    { id: "src", kind: "source", position: { x: 0, y: 0 } },
    { id: "w", kind: "worker", change: "added", position: { x: 400, y: 0 } },
  ],
  rails: [{ id: "jobs", from: "src.out", to: "w.in", change: "added" }],
  cards: [{ id: "job", token: "request", label: "J" }],
  story: [
    {
      caption: "a job is sent",
      steps: [{ verb: "send", part: "src", card: "job" }],
    },
    {
      caption: "the worker runs it",
      steps: [
        { verb: "stage", part: "w", card: "job", via: "jobs" },
        { verb: "finish", part: "w", card: "job" },
      ],
    },
  ],
};

const parsed = parseFlowSpec(inlineDiscussions);
if (!parsed.ok) throw new Error("fixture does not parse");
const fixture = parsed.value;

/** The fixture with `process` drilling into `inner` and `tools` into an artifact. */
function spec(drills: Record<string, unknown> = {}) {
  const s = structuredClone(fixture) as {
    parts: { id: string; drill?: unknown }[];
  };
  const d = {
    process: { spec: inner },
    tools: { artifact: ARTIFACT_ID },
    ...drills,
  };
  for (const p of s.parts)
    if (d[p.id as keyof typeof d]) p.drill = d[p.id as keyof typeof d];
  return JSON.stringify(s);
}

function artifact(overrides: Partial<Artifact> = {}): Artifact {
  return {
    id: ARTIFACT_ID,
    project_id: "p",
    filename: "tools.flow.json",
    body: JSON.stringify({ ...inner, title: "Tool guard" }),
    logical_name: null,
    metadata: {
      version: 1,
      content_kind: "flow",
      format: "json",
      origin: "chat",
      presentation: "rendered",
      extensions: {},
    },
    created_at: null,
    updated_at: null,
    ...overrides,
  };
}

const level = (n: number) =>
  document.querySelector(`[data-drill-level='${n}']`) as HTMLElement;
const playerAt = (n: number) => within(level(n)).getByTestId("flow-player");
const partAt = (n: number, id: string) =>
  level(n).querySelector(`[data-part-id='${id}']`) as SVGGElement;
const breadcrumb = () => screen.getByTestId("flow-breadcrumb");

function renderView(source = spec()) {
  return render(<FlowSpecView source={source} />);
}

beforeEach(() => {
  resetProjectScopedStores();
  queryClient.clear();
  list.mockReset();
  list.mockResolvedValue({ status: "ok", data: [artifact()] });
});

afterEach(() => {
  cleanup();
});

describe("drill-down affordance", () => {
  it("marks parts with a sub-spec by shape and accessible name, not colour", () => {
    renderView();
    for (const id of ["process", "tools"]) {
      const p = partAt(0, id);
      expect(p.querySelector("[data-testid='flow-drill-mark']")).not.toBeNull();
      expect(p.getAttribute("aria-label")).toContain(DRILL_HINT);
    }
    const plain = partAt(0, "you");
    expect(plain.querySelector("[data-testid='flow-drill-mark']")).toBeNull();
    expect(plain.getAttribute("aria-label")).not.toContain(DRILL_HINT);
  });

  it("activating a part without a sub-spec stays on the diagram", () => {
    renderView();
    fireEvent.click(partAt(0, "you"));
    expect(screen.queryByTestId("flow-breadcrumb")).toBeNull();
    expect(screen.getByTestId("flow-drill")).toHaveAttribute("data-depth", "0");
  });
});

describe("drilling in and back", () => {
  it("opens the sub-diagram by click with a breadcrumb; back restores beat, arrangement, pin and follow", () => {
    renderView();
    const top = playerAt(0);
    act(() => top.focus());
    // q1 is drawn on the first beat's outcome; following survives beats.
    fireEvent.click(top.querySelector(".md-card[data-card-id='q1']")!);
    fireEvent.keyDown(top, { key: "ArrowRight" });
    fireEvent.keyDown(top, { key: "ArrowRight" });
    fireEvent.keyDown(top, { key: "b" });
    expect(top).toHaveAttribute("data-beat", "2");
    expect(top).toHaveAttribute("data-arrangement", "before");
    expect(top).toHaveAttribute("data-following", "q1");

    fireEvent.click(partAt(0, "process"));

    expect(level(0)).not.toBeVisible();
    const sub = playerAt(1);
    expect(sub).toBeVisible();
    expect(sub).toHaveAccessibleName("Flow player: Inside the session");
    expect(document.activeElement).toBe(sub);
    const crumbs = within(breadcrumb());
    expect(crumbs.getByText("discussion session")).toHaveAttribute(
      "aria-current",
      "page"
    );
    expect(
      crumbs.getByRole("button", {
        name: "Inline discussions keep one session per thread",
      })
    ).toBeInTheDocument();

    fireEvent.click(crumbs.getByRole("button", { name: /back/i }));

    expect(screen.queryByTestId("flow-breadcrumb")).toBeNull();
    expect(document.querySelector("[data-drill-level='1']")).toBeNull();
    expect(level(0)).toBeVisible();
    expect(top).toHaveAttribute("data-beat", "2");
    expect(top).toHaveAttribute("data-arrangement", "before");
    expect(top).toHaveAttribute("data-following", "q1");
    expect(partAt(0, "process")).toHaveAttribute("data-active", "true");
    expect(within(top).getByTestId("flow-part-inspector")).toHaveAttribute(
      "data-part-id",
      "process"
    );
    expect(document.activeElement).toBe(partAt(0, "process"));
  });

  it("opens by keyboard; the sub-diagram has its own Before/After; Esc stays with the panel", () => {
    renderView();
    const p = partAt(0, "process");
    act(() => p.focus());
    fireEvent.keyDown(p, { key: "Enter" });

    const sub = playerAt(1);
    expect(document.activeElement).toBe(sub);
    expect(sub).toHaveAttribute("data-arrangement", "after");
    fireEvent.keyDown(sub, { key: "b" });
    expect(sub).toHaveAttribute("data-arrangement", "before");
    expect(
      within(sub).getByRole("radiogroup", { name: "Arrangement" })
    ).toBeInTheDocument();

    // Esc belongs to the enclosing panel: it does not go up a level.
    fireEvent.keyDown(sub, { key: "Escape" });
    expect(breadcrumb()).toBeInTheDocument();
    expect(level(0)).not.toBeVisible();
  });

  it("pauses the parent while hidden so its beat is where it was left", () => {
    renderView();
    const top = playerAt(0);
    act(() => top.focus());
    fireEvent.keyDown(top, { key: " " });
    expect(top).toHaveAttribute("data-playing", "true");
    fireEvent.click(partAt(0, "process"));
    expect(top).toHaveAttribute("data-playing", "false");
  });

  it("opens a saved flow artifact laid out on its own", async () => {
    renderView();
    fireEvent.click(partAt(0, "tools"));
    const sub = await within(level(1)).findByTestId("flow-player");
    expect(sub).toHaveAccessibleName("Flow player: Tool guard");
    expect(list).toHaveBeenCalled();
  });

  it("drills more than one level and jumps back up from the breadcrumb", () => {
    const nested = {
      ...inner,
      parts: inner.parts.map((p) =>
        p.id === "w"
          ? { ...p, drill: { spec: { ...inner, title: "Deepest" } } }
          : p
      ),
    };
    renderView(spec({ process: { spec: nested } }));
    fireEvent.click(partAt(0, "process"));
    fireEvent.click(partAt(1, "w"));
    expect(playerAt(2)).toHaveAccessibleName("Flow player: Deepest");
    expect(level(1)).not.toBeVisible();
    const crumbs = within(breadcrumb());
    expect(crumbs.getAllByRole("listitem")).toHaveLength(3);
    fireEvent.click(
      crumbs.getByRole("button", {
        name: "Inline discussions keep one session per thread",
      })
    );
    expect(screen.queryByTestId("flow-breadcrumb")).toBeNull();
    expect(level(0)).toBeVisible();
  });
});

describe("unusable sub-specs", () => {
  it("a missing artifact shows its error in place of the sub-diagram", async () => {
    list.mockResolvedValue({ status: "ok", data: [] });
    renderView();
    fireEvent.click(partAt(0, "tools"));
    const err = await within(level(1)).findByTestId("flow-drill-error");
    expect(err).toHaveTextContent(
      `Drill-down artifact ${ARTIFACT_ID} was not found`
    );
    expect(
      within(breadcrumb()).getByText("read_only_decision")
    ).toBeInTheDocument();
  });

  it("an artifact that is not a flow spec says so", async () => {
    list.mockResolvedValue({
      status: "ok",
      data: [
        artifact({
          metadata: { ...artifact().metadata!, content_kind: "statechart" },
        }),
      ],
    });
    renderView();
    fireEvent.click(partAt(0, "tools"));
    expect(
      await within(level(1)).findByTestId("flow-drill-error")
    ).toHaveTextContent("tools.flow.json is not a flow spec");
  });

  it("an invalid artifact spec lists its errors with spec paths", async () => {
    list.mockResolvedValue({
      status: "ok",
      data: [
        artifact({
          body: JSON.stringify({
            version: 1,
            parts: [{ id: "x", kind: "nope" }],
          }),
        }),
      ],
    });
    renderView();
    fireEvent.click(partAt(0, "tools"));
    const errors = await within(level(1)).findByTestId("flow-errors");
    expect(errors).toHaveTextContent(/unknown part kind "nope"/);
    expect(within(level(1)).queryByTestId("flow-player")).toBeNull();
  });

  it("a load failure shows the error with a retry", async () => {
    list.mockRejectedValue(new Error("offline"));
    renderView();
    fireEvent.click(partAt(0, "tools"));
    const err = await within(level(1)).findByTestId("flow-drill-error");
    expect(err).toHaveTextContent(/Unable to load drill-down artifact/);
    expect(
      within(err).getByRole("button", { name: "Retry" })
    ).toBeInTheDocument();
  });
});

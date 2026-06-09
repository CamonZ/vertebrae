import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { EventGlyph, resolveGlyph } from "./EventGlyph";
import type {
  ConversationEvent,
  ToolCallEvent,
  ToolResultEvent,
} from "../../types/conversation";
import type {
  ThresholdMarker,
  ToolMarker,
  MainMarker,
  DelegationEdge,
  ThresholdMarkerKind,
} from "./legacyMarkers";

function threshold(kind: ThresholdMarkerKind): ThresholdMarker {
  return {
    lane: "threshold",
    kind,
    x: 0,
    timestampMs: 0,
    executionId: "e",
    taskId: "t",
    fromStep: null,
    toStep: null,
    label: "",
  };
}

function toolMarker(
  toolName: string,
  kind: "tool_use" | "tool_result",
  isError = false
): ToolMarker {
  return {
    lane: "tool",
    kind,
    x: 0,
    timestampMs: 0,
    executionId: "e",
    taskId: "t",
    toolId: "tu-1",
    toolName,
    isError,
  };
}

const MAIN_MARKER: MainMarker = {
  lane: "main",
  kind: "message",
  x: 0,
  timestampMs: 0,
  executionId: "e",
  taskId: "t",
  rowIndex: 0,
};

const DELEGATION: DelegationEdge = {
  lane: "delegation",
  x: 0,
  timestampMs: 0,
  parentTaskId: "p",
  childTaskId: "c",
  parentTaskRunId: null,
  childTaskRunId: null,
  parentRowIndex: 0,
  childRowIndex: 1,
  childLevel: "ticket",
};

const SESSION_START: ConversationEvent = {
  kind: "session_start",
  timestamp: "2026-01-01T00:00:00Z",
  model: "claude",
  sessionId: "s-1",
};

const SESSION_END: ConversationEvent = {
  kind: "session_end",
  timestamp: "2026-01-01T00:00:00Z",
  durationMs: 100,
  numTurns: 1,
  costUsd: 0,
};

const THINKING: ConversationEvent = {
  kind: "thinking",
  timestamp: "2026-01-01T00:00:00Z",
  text: "hmm",
};

const TOOL_CALL_BASH: ToolCallEvent = {
  kind: "tool_call",
  timestamp: "2026-01-01T00:00:00Z",
  toolId: "tu-1",
  toolName: "Bash",
  displayName: "Bash",
  icon: "terminal",
  summary: "ls",
  input: {},
};

const TOOL_RESULT_OK: ToolResultEvent = {
  kind: "tool_result",
  timestamp: "2026-01-01T00:00:00Z",
  toolUseId: "tu-1",
  isError: false,
  result: "ok",
};

const TOOL_RESULT_ERR: ToolResultEvent = {
  kind: "tool_result",
  timestamp: "2026-01-01T00:00:00Z",
  toolUseId: "tu-1",
  isError: true,
  result: "boom",
};

describe("resolveGlyph — threshold markers", () => {
  const cases: Array<[ThresholdMarkerKind, string, string]> = [
    ["transition", "arrow-right", "default"],
    ["retry", "rotate-cw", "default"],
    ["rejection", "x-circle", "error"],
    ["approval", "check-circle", "default"],
    ["model_fallback", "shuffle", "default"],
    ["execution_start", "play-circle", "default"],
    ["execution_end", "flag", "default"],
  ];
  for (const [kind, glyph, variant] of cases) {
    it(`maps threshold ${kind} -> ${glyph}/${variant}`, () => {
      const r = resolveGlyph(threshold(kind));
      expect(r.glyph).toBe(glyph);
      expect(r.variant).toBe(variant);
    });
  }
});

describe("resolveGlyph — tool markers", () => {
  it("maps Bash tool_use to terminal/default", () => {
    const r = resolveGlyph(toolMarker("Bash", "tool_use"));
    expect(r.glyph).toBe("terminal");
    expect(r.variant).toBe("default");
    expect(r.label).toBe("tool call");
  });

  it("maps Read tool_result OK to file-text/filled", () => {
    const r = resolveGlyph(toolMarker("Read", "tool_result", false));
    expect(r.glyph).toBe("file-text");
    expect(r.variant).toBe("filled");
    expect(r.label).toBe("tool result");
  });

  it("maps tool_result with isError to error variant", () => {
    const r = resolveGlyph(toolMarker("Edit", "tool_result", true));
    expect(r.glyph).toBe("edit");
    expect(r.variant).toBe("error");
    expect(r.label).toBe("tool error");
  });

  it("falls back to wrench for unknown tools", () => {
    const r = resolveGlyph(toolMarker("UnknownTool", "tool_use"));
    expect(r.glyph).toBe("wrench");
  });

  it("infers search glyph from tool name containing 'search'", () => {
    const r = resolveGlyph(toolMarker("custom_search_tool", "tool_use"));
    expect(r.glyph).toBe("search");
  });
});

describe("resolveGlyph — main markers", () => {
  it("maps main lane message to brain/default (thinking)", () => {
    const r = resolveGlyph(MAIN_MARKER);
    expect(r.glyph).toBe("brain");
    expect(r.label).toBe("thinking");
  });
});

describe("resolveGlyph — delegation edges", () => {
  it("maps delegation edge to git-branch", () => {
    const r = resolveGlyph(DELEGATION);
    expect(r.glyph).toBe("git-branch");
    expect(r.label).toBe("delegation");
  });
});

describe("resolveGlyph — conversation events", () => {
  it("maps session_start to play", () => {
    expect(resolveGlyph(SESSION_START).glyph).toBe("play");
  });
  it("maps session_end to stop", () => {
    expect(resolveGlyph(SESSION_END).glyph).toBe("stop");
  });
  it("maps thinking to brain", () => {
    expect(resolveGlyph(THINKING).glyph).toBe("brain");
  });
  it("maps tool_call event to per-tool glyph", () => {
    expect(resolveGlyph(TOOL_CALL_BASH).glyph).toBe("terminal");
  });
  it("maps tool_result event success to filled wrench (no toolName on event)", () => {
    const r = resolveGlyph(TOOL_RESULT_OK);
    expect(r.glyph).toBe("wrench");
    expect(r.variant).toBe("filled");
  });
  it("maps tool_result event error to error variant", () => {
    const r = resolveGlyph(TOOL_RESULT_ERR);
    expect(r.variant).toBe("error");
  });
});

describe("EventGlyph component", () => {
  it("renders an svg with the resolved glyph metadata", () => {
    render(<EventGlyph event={threshold("approval")} />);
    const el = screen.getByTestId("event-glyph");
    expect(el.getAttribute("data-glyph")).toBe("check-circle");
    expect(el.getAttribute("data-variant")).toBe("default");
    expect(el.getAttribute("data-label")).toBe("approval");
    expect(el.getAttribute("aria-label")).toBe("approval");
    expect(el.querySelector("svg")).not.toBeNull();
  });

  it("respects the size prop on the inner svg", () => {
    render(<EventGlyph event={threshold("retry")} size={24} />);
    const svg = screen.getByTestId("event-glyph").querySelector("svg")!;
    expect(svg.getAttribute("width")).toBe("24");
    expect(svg.getAttribute("height")).toBe("24");
  });

  it("renders filled variant with fill=currentColor", () => {
    render(<EventGlyph event={toolMarker("Read", "tool_result", false)} />);
    const svg = screen.getByTestId("event-glyph").querySelector("svg")!;
    expect(svg.getAttribute("fill")).toBe("currentColor");
  });

  it("renders default variant with fill=none", () => {
    render(<EventGlyph event={threshold("transition")} />);
    const svg = screen.getByTestId("event-glyph").querySelector("svg")!;
    expect(svg.getAttribute("fill")).toBe("none");
  });

  it("uses error variant class for rejection", () => {
    render(<EventGlyph event={threshold("rejection")} />);
    const el = screen.getByTestId("event-glyph");
    expect(el.className).toContain("text-[var(--color-err)]");
  });

  it("allows overriding the title/label", () => {
    render(
      <EventGlyph event={threshold("approval")} title="Approved by reviewer" />
    );
    const el = screen.getByTestId("event-glyph");
    expect(el.getAttribute("title")).toBe("Approved by reviewer");
    expect(el.getAttribute("aria-label")).toBe("Approved by reviewer");
  });

  it("merges custom className with variant class", () => {
    render(
      <EventGlyph event={threshold("approval")} className="ml-2 my-custom" />
    );
    const el = screen.getByTestId("event-glyph");
    expect(el.className).toContain("ml-2");
    expect(el.className).toContain("my-custom");
    expect(el.className).toContain("text-[var(--color-fg-soft)]");
  });
});

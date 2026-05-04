import { describe, it, expect } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { useContext } from "react";
import {
  EventRenderer,
  TimeModeContext,
  formatDurationShort,
  formatTimeWithMs,
  formatDifferential,
  humanizeStepName,
} from "./EventRenderer";
import type {
  ConversationEvent,
  SessionStartEvent,
  SessionEndEvent,
  ThinkingEvent,
  ToolCallEvent,
  ToolResultEvent,
} from "../../../types/conversation";

describe("formatting helpers", () => {
  it("humanizeStepName replaces underscores", () => {
    expect(humanizeStepName("in_progress")).toBe("in progress");
    expect(humanizeStepName(null)).toBe("step");
    expect(humanizeStepName("")).toBe("step");
  });

  it("formatDurationShort scales by magnitude", () => {
    expect(formatDurationShort(500)).toBe("500ms");
    expect(formatDurationShort(1500)).toBe("1.5s");
    expect(formatDurationShort(125000)).toBe("2m 5s");
  });

  it("formatTimeWithMs returns HH:MM:SS.mmm", () => {
    const out = formatTimeWithMs("2026-01-15T13:45:30.123Z");
    expect(out).toMatch(/^\d{2}:\d{2}:\d{2}\.\d{3}$/);
    expect(out.endsWith(".123")).toBe(true);
  });

  it("formatDifferential returns scaled 'after' string for forward-in-time delta", () => {
    // Events render oldest-to-newest, so the delta from event N to event
    // N+1 represents how long *after* event N the next one happened.
    const a = "2026-01-15T13:45:30.000Z";
    const b = "2026-01-15T13:45:30.250Z";
    expect(formatDifferential(b, a)).toBe("250ms after");
    const later = "2026-01-15T13:45:32.500Z";
    expect(formatDifferential(later, a)).toBe("2.5s after");
    const minutes = "2026-01-15T13:47:35.000Z";
    expect(formatDifferential(minutes, a)).toBe("2m 5s after");
  });

  it("formatDifferential returns em-dash for the first event (no previous)", () => {
    const a = "2026-01-15T13:45:30.000Z";
    expect(formatDifferential(a, null)).toBe("—");
  });
});

describe("EventRenderer", () => {
  const ts = "2026-01-15T13:45:30.123Z";

  it("does NOT render a Session Started card — facts are folded into the StepBoundary header", () => {
    const event: SessionStartEvent = {
      kind: "session_start",
      timestamp: ts,
      model: "claude-opus-4-7",
      sessionId: "sess-1",
    };
    const { container } = render(
      <EventRenderer event={event} previousTimestamp={null} />
    );
    expect(screen.queryByText("Session Started")).toBeNull();
    expect(screen.queryByText(/claude-opus-4-7/)).toBeNull();
    expect(container.firstChild).toBeNull();
  });

  it("does NOT render a Session Complete card — facts are folded into the StepBoundary header", () => {
    const event: SessionEndEvent = {
      kind: "session_end",
      timestamp: ts,
      durationMs: 1500,
      numTurns: 3,
      costUsd: 0.05,
    };
    const { container } = render(
      <EventRenderer event={event} previousTimestamp={null} />
    );
    expect(screen.queryByText("Session Complete")).toBeNull();
    expect(screen.queryByText("3 turns")).toBeNull();
    expect(screen.queryByText("$0.0500")).toBeNull();
    expect(container.firstChild).toBeNull();
  });

  it("renders thinking text in full with no Show more / Show less affordance", () => {
    const longText = "x".repeat(500);
    const event: ThinkingEvent = {
      kind: "thinking",
      timestamp: ts,
      text: longText,
    };
    render(<EventRenderer event={event} previousTimestamp={null} />);
    expect(screen.queryByText("Show more")).toBeNull();
    expect(screen.queryByText("Show less")).toBeNull();
    // Full content rendered, no ellipsis truncation
    expect(screen.getByText(longText)).toBeInTheDocument();
  });

  it("renders tool_call summary in full with no truncation and toggles input details", () => {
    // Long string > 200 chars, the legacy mid-string truncation threshold.
    // Use a continuous string with no trailing whitespace so the
    // testing-library text matcher (whitespace-normalizing) finds it.
    const longArg = "x".repeat(500);
    const longSummary = `ls -la ${longArg}`;
    const event: ToolCallEvent = {
      kind: "tool_call",
      timestamp: ts,
      toolId: "tool-1",
      toolName: "Bash",
      displayName: "Bash",
      icon: "terminal",
      summary: longSummary,
      input: { command: longArg },
    };
    render(<EventRenderer event={event} previousTimestamp={null} />);
    expect(screen.getByText("Bash")).toBeInTheDocument();
    // Full summary visible; no horizontal truncation marker.
    expect(screen.getByText(longSummary)).toBeInTheDocument();
    // No legacy mid-string ellipsis '…' or three-dot truncation.
    expect(screen.queryByText(/…/)).toBeNull();

    expect(screen.queryByText(/command:/)).toBeNull();
    fireEvent.click(screen.getByText(longSummary));
    expect(screen.getByText(/command:/)).toBeInTheDocument();
    // The argument value is also rendered in full inside the input panel —
    // legacy code chopped string args at 200 chars with '...'.
    expect(screen.getByText(longArg)).toBeInTheDocument();
  });

  it("renders tool_result in full and styles errors differently", () => {
    // Use a long single-line string (no newlines, since testing-library
    // collapses whitespace differently across nodes). 500 chars exceeds
    // the legacy 100-char truncation threshold.
    const longResult = "y".repeat(500);
    const ok: ToolResultEvent = {
      kind: "tool_result",
      timestamp: ts,
      toolUseId: "t",
      isError: false,
      result: longResult,
    };
    const { rerender } = render(
      <EventRenderer event={ok} previousTimestamp={null} />
    );
    expect(screen.getByText(longResult)).toBeInTheDocument();
    // Legacy truncation appended '...' once result.length > 100.
    expect(screen.queryByText(/y{100}\.\.\./)).toBeNull();

    const err: ToolResultEvent = { ...ok, isError: true, result: "boom" };
    rerender(<EventRenderer event={err} previousTimestamp={null} />);
    const text = screen.getByText("boom");
    expect(text.className).toMatch(/text-error/);
  });

  it("renders EventGlyph (brain) for thinking events", () => {
    const event: ThinkingEvent = {
      kind: "thinking",
      timestamp: ts,
      text: "thinking",
    };
    render(<EventRenderer event={event} previousTimestamp={null} />);
    const glyph = screen.getByTestId("event-glyph");
    expect(glyph.getAttribute("data-glyph")).toBe("brain");
    expect(glyph.getAttribute("data-label")).toBe("thinking");
  });

  it("tints the thinking glyph by task level (epic → text-info)", () => {
    const event: ThinkingEvent = {
      kind: "thinking",
      timestamp: ts,
      text: "x",
    };
    render(
      <EventRenderer event={event} previousTimestamp={null} level="epic" />
    );
    const glyph = screen.getByTestId("event-glyph");
    expect(glyph.className).toMatch(/text-info/);
  });

  it("renders EventGlyph for tool_call events with tool-specific glyph (Bash → terminal)", () => {
    const event: ToolCallEvent = {
      kind: "tool_call",
      timestamp: ts,
      toolId: "tool-1",
      toolName: "Bash",
      displayName: "Bash",
      icon: "terminal",
      summary: "ls",
      input: { command: "ls" },
    };
    render(<EventRenderer event={event} previousTimestamp={null} />);
    const glyph = screen.getByTestId("event-glyph");
    expect(glyph.getAttribute("data-glyph")).toBe("terminal");
  });

  it("renders EventGlyph for tool_call events (Edit → edit glyph)", () => {
    const event: ToolCallEvent = {
      kind: "tool_call",
      timestamp: ts,
      toolId: "tool-1",
      toolName: "Edit",
      displayName: "Edit",
      icon: "edit",
      summary: "edit foo",
      input: {},
    };
    render(<EventRenderer event={event} previousTimestamp={null} />);
    const glyph = screen.getByTestId("event-glyph");
    expect(glyph.getAttribute("data-glyph")).toBe("edit");
  });

  it("renders EventGlyph for successful tool_result with filled variant", () => {
    const event: ToolResultEvent = {
      kind: "tool_result",
      timestamp: ts,
      toolUseId: "t",
      isError: false,
      result: "ok",
    };
    render(<EventRenderer event={event} previousTimestamp={null} />);
    const glyph = screen.getByTestId("event-glyph");
    expect(glyph.getAttribute("data-variant")).toBe("filled");
    expect(glyph.getAttribute("data-label")).toBe("tool result");
  });

  it("renders EventGlyph for failing tool_result with error variant + text-error tint", () => {
    const event: ToolResultEvent = {
      kind: "tool_result",
      timestamp: ts,
      toolUseId: "t",
      isError: true,
      result: "boom",
    };
    render(<EventRenderer event={event} previousTimestamp={null} />);
    const glyph = screen.getByTestId("event-glyph");
    expect(glyph.getAttribute("data-variant")).toBe("error");
    expect(glyph.getAttribute("data-label")).toBe("tool error");
    expect(glyph.className).toMatch(/text-error/);
  });

  it("returns null for unknown event kinds", () => {
    const { container } = render(
      <EventRenderer
        event={{ kind: "bogus" } as unknown as ConversationEvent}
        previousTimestamp={null}
      />
    );
    expect(container.firstChild).toBeNull();
  });
});

describe("TimeModeContext", () => {
  function ContextReader() {
    const { mode } = useContext(TimeModeContext);
    return <span data-testid="mode">{mode}</span>;
  }

  it("provides 'absolute' as default", () => {
    render(<ContextReader />);
    expect(screen.getByTestId("mode").textContent).toBe("absolute");
  });
});

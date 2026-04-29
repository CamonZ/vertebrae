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

  it("formatDifferential returns scaled 'before' string", () => {
    const a = "2026-01-15T13:45:30.000Z";
    const b = "2026-01-15T13:45:30.250Z";
    expect(formatDifferential(b, a)).toBe("250ms before");
    expect(formatDifferential(a, null)).toBe("0ms before");
    const later = "2026-01-15T13:45:32.500Z";
    expect(formatDifferential(later, a)).toBe("2.5s before");
  });
});

describe("EventRenderer", () => {
  const ts = "2026-01-15T13:45:30.123Z";

  it("renders session_start with model", () => {
    const event: SessionStartEvent = {
      kind: "session_start",
      timestamp: ts,
      model: "claude-opus-4-7",
      sessionId: "sess-1",
    };
    render(<EventRenderer event={event} previousTimestamp={null} />);
    expect(screen.getByText("Session Started")).toBeInTheDocument();
    expect(screen.getByText(/claude-opus-4-7/)).toBeInTheDocument();
  });

  it("renders session_end with cost when > 0", () => {
    const event: SessionEndEvent = {
      kind: "session_end",
      timestamp: ts,
      durationMs: 1500,
      numTurns: 3,
      costUsd: 0.05,
    };
    render(<EventRenderer event={event} previousTimestamp={null} />);
    expect(screen.getByText("Session Complete")).toBeInTheDocument();
    expect(screen.getByText("3 turns")).toBeInTheDocument();
    expect(screen.getByText("$0.0500")).toBeInTheDocument();
  });

  it("renders thinking text and toggles long content", () => {
    const longText = "x".repeat(300);
    const event: ThinkingEvent = {
      kind: "thinking",
      timestamp: ts,
      text: longText,
    };
    render(<EventRenderer event={event} previousTimestamp={null} />);
    const more = screen.getByText("Show more");
    fireEvent.click(more);
    expect(screen.getByText("Show less")).toBeInTheDocument();
  });

  it("renders tool_call and toggles input details on click", () => {
    const event: ToolCallEvent = {
      kind: "tool_call",
      timestamp: ts,
      toolId: "tool-1",
      toolName: "Bash",
      displayName: "Bash",
      icon: "terminal",
      summary: "ls -la",
      input: { command: "ls -la" },
    };
    render(<EventRenderer event={event} previousTimestamp={null} />);
    expect(screen.getByText("Bash")).toBeInTheDocument();
    expect(screen.getByText("ls -la")).toBeInTheDocument();
    expect(screen.queryByText(/command:/)).toBeNull();
    fireEvent.click(screen.getByText("ls -la"));
    expect(screen.getByText(/command:/)).toBeInTheDocument();
  });

  it("renders tool_result and styles errors differently", () => {
    const ok: ToolResultEvent = {
      kind: "tool_result",
      timestamp: ts,
      toolUseId: "t",
      isError: false,
      result: "done",
    };
    const { rerender } = render(<EventRenderer event={ok} previousTimestamp={null} />);
    expect(screen.getByText("done")).toBeInTheDocument();
    const err: ToolResultEvent = { ...ok, isError: true, result: "boom" };
    rerender(<EventRenderer event={err} previousTimestamp={null} />);
    const text = screen.getByText("boom");
    expect(text.className).toMatch(/text-error/);
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

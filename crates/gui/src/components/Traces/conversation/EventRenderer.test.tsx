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
  AssistantMessageEvent,
  ConversationEvent,
  FileEditEvent,
  SessionStartEvent,
  SessionEndEvent,
  ThinkingEvent,
  TodoListEvent,
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

  it("renders tool_call as a ToolCallBlock with the tool name and summary visible", () => {
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
    // Summary is shown next to the tool name in the collapsed header.
    expect(screen.getByText(longSummary)).toBeInTheDocument();
    // Input is rendered as a JSON pre block once expanded.
    const header = screen.getByRole("button", { expanded: false });
    fireEvent.click(header);
    expect(screen.getByText(/"command"/)).toBeInTheDocument();
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

  it("renders the tool name as the ToolCallBlock header (Bash)", () => {
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
    expect(screen.getByText("Bash")).toBeInTheDocument();
  });

  it("renders the tool name as the ToolCallBlock header (Edit)", () => {
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
    expect(screen.getByText("Edit")).toBeInTheDocument();
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

  it("renders assistant_message text inside its own block, distinct from thinking", () => {
    const event: AssistantMessageEvent = {
      kind: "assistant_message",
      timestamp: ts,
      text: "Here is your final answer.",
    };
    render(<EventRenderer event={event} previousTimestamp={null} />);
    const block = screen.getByTestId("assistant-message");
    expect(block).toBeInTheDocument();
    // Heading marker that distinguishes the assistant block from thinking
    expect(screen.getByText("assistant")).toBeInTheDocument();
    expect(
      screen.getByText("Here is your final answer.")
    ).toBeInTheDocument();
  });

  it("renders file_edit with one row per change and reveals the diff on click when present", () => {
    const event: FileEditEvent = {
      kind: "file_edit",
      timestamp: ts,
      toolId: "fc1",
      status: "completed",
      changes: [
        { path: "src/foo.rs", kind: "update", diff: "@@ -1 +1 @@\n-old\n+new" },
        { path: "src/bar.rs", kind: "add" },
      ],
    };
    render(<EventRenderer event={event} previousTimestamp={null} />);
    const block = screen.getByTestId("file-edit");
    expect(block.getAttribute("data-status")).toBe("completed");
    // Both file paths render as their own rows
    expect(screen.getByText("src/foo.rs")).toBeInTheDocument();
    expect(screen.getByText("src/bar.rs")).toBeInTheDocument();
    // Per-change kind label
    expect(screen.getByText("update")).toBeInTheDocument();
    expect(screen.getByText("add")).toBeInTheDocument();
    // Diff body is hidden until the row is clicked
    expect(screen.queryByText("-old")).toBeNull();
    fireEvent.click(screen.getByText("src/foo.rs"));
    expect(screen.getByText("-old")).toBeInTheDocument();
    expect(screen.getByText("+new")).toBeInTheDocument();
  });

  it("renders failed file_edit status with the patch-failed marker and error tint", () => {
    const event: FileEditEvent = {
      kind: "file_edit",
      timestamp: ts,
      toolId: "fc2",
      status: "failed",
      changes: [{ path: "src/x.rs", kind: "update" }],
    };
    render(<EventRenderer event={event} previousTimestamp={null} />);
    const label = screen.getByText("patch failed");
    expect(label.className).toMatch(/text-error/);
  });

  it("renders todo_list as a checklist with completed items struck through", () => {
    const event: TodoListEvent = {
      kind: "todo_list",
      timestamp: ts,
      itemId: "plan-1",
      items: [
        { text: "first step", completed: true },
        { text: "second step", completed: false },
      ],
    };
    render(<EventRenderer event={event} previousTimestamp={null} />);
    const block = screen.getByTestId("todo-list");
    expect(block.getAttribute("data-item-id")).toBe("plan-1");
    const first = screen.getByText("first step");
    const second = screen.getByText("second step");
    expect(first.className).toMatch(/line-through/);
    expect(second.className).not.toMatch(/line-through/);
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

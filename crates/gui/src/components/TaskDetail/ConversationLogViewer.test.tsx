import { describe, it, expect } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { ConversationLogViewer } from "./ConversationLogViewer";
import type { SessionLog } from "../../bindings";

const createLog = (content: string, createdAt: string): SessionLog => ({
  id: `log-${createdAt}`,
  step_execution_id: "exec-1",
  content,
  created_at: createdAt,
});

const createThinkingLog = (text: string, createdAt: string) =>
  createLog(
    JSON.stringify({
      type: "assistant",
      message: { content: [{ type: "text", text }] },
    }),
    createdAt
  );

const createToolCallLog = (name: string, input: Record<string, unknown>, createdAt: string) =>
  createLog(
    JSON.stringify({
      type: "assistant",
      message: {
        content: [
          { type: "tool_use", id: "tool-1", name, input },
        ],
      },
    }),
    createdAt
  );

const createSessionStartLog = (model: string, createdAt: string) =>
  createLog(
    JSON.stringify({
      type: "system",
      subtype: "init",
      model,
      session_id: "sess-123",
    }),
    createdAt
  );

const createSessionEndLog = (durationMs: number, numTurns: number, costUsd: number, createdAt: string) =>
  createLog(
    JSON.stringify({
      type: "result",
      subtype: "success",
      duration_ms: durationMs,
      num_turns: numTurns,
      total_cost_usd: costUsd,
    }),
    createdAt
  );

describe("ConversationLogViewer", () => {
  describe("empty state", () => {
    it("shows message when no logs provided", () => {
      render(<ConversationLogViewer logs={[]} />);
      expect(screen.getByText("No conversation data available")).toBeInTheDocument();
    });

    it("shows message when logs cannot be parsed", () => {
      const logs = [createLog("not valid json", "2024-01-01T10:00:00Z")];
      render(<ConversationLogViewer logs={logs} />);
      expect(screen.getByText("No conversation data available")).toBeInTheDocument();
    });
  });

  describe("session events", () => {
    it("displays session start with model info", () => {
      const logs = [createSessionStartLog("claude-3-opus", "2024-01-01T10:00:00Z")];
      render(<ConversationLogViewer logs={logs} />);

      expect(screen.getByText("Session Started")).toBeInTheDocument();
      expect(screen.getByText("Model: claude-3-opus")).toBeInTheDocument();
    });

    it("displays session end with stats", () => {
      const logs = [createSessionEndLog(5000, 10, 0.05, "2024-01-01T10:00:00Z")];
      render(<ConversationLogViewer logs={logs} />);

      expect(screen.getByText("Session Complete")).toBeInTheDocument();
      expect(screen.getByText("5.0s")).toBeInTheDocument();
      expect(screen.getByText("10 turns")).toBeInTheDocument();
      expect(screen.getByText("$0.0500")).toBeInTheDocument();
    });
  });

  describe("thinking events", () => {
    it("displays thinking text", () => {
      const logs = [createThinkingLog("Let me analyze this...", "2024-01-01T10:00:00Z")];
      render(<ConversationLogViewer logs={logs} />);

      expect(screen.getByText("Let me analyze this...")).toBeInTheDocument();
    });

    it("truncates long thinking text", () => {
      const longText = "A".repeat(300);
      const logs = [createThinkingLog(longText, "2024-01-01T10:00:00Z")];
      render(<ConversationLogViewer logs={logs} />);

      // Should show truncated text with Show more button
      expect(screen.getByText("Show more")).toBeInTheDocument();
    });

    it("expands truncated thinking text on click", () => {
      const longText = "A".repeat(300);
      const logs = [createThinkingLog(longText, "2024-01-01T10:00:00Z")];
      render(<ConversationLogViewer logs={logs} />);

      fireEvent.click(screen.getByText("Show more"));
      expect(screen.getByText("Show less")).toBeInTheDocument();
    });
  });

  describe("tool call events", () => {
    it("displays Bash tool calls with command", () => {
      const logs = [
        createToolCallLog("Bash", { command: "ls -la" }, "2024-01-01T10:00:00Z"),
      ];
      render(<ConversationLogViewer logs={logs} />);

      expect(screen.getByText("Bash")).toBeInTheDocument();
      expect(screen.getByText("ls -la")).toBeInTheDocument();
    });

    it("displays Read tool calls with filename", () => {
      const logs = [
        createToolCallLog("Read", { file_path: "/path/to/file.ts" }, "2024-01-01T10:00:00Z"),
      ];
      render(<ConversationLogViewer logs={logs} />);

      expect(screen.getByText("Read")).toBeInTheDocument();
      expect(screen.getByText("file.ts")).toBeInTheDocument();
    });

    it("expands tool input on click", () => {
      const logs = [
        createToolCallLog("Bash", { command: "ls -la", timeout: 5000 }, "2024-01-01T10:00:00Z"),
      ];
      render(<ConversationLogViewer logs={logs} />);

      // Click to expand
      fireEvent.click(screen.getByText("Bash"));

      // Should show pretty-printed input with key and value
      expect(screen.getByText("timeout:")).toBeInTheDocument();
      expect(screen.getByText("5000")).toBeInTheDocument();
    });
  });

  describe("pagination", () => {
    it("limits displayed events", () => {
      const logs = Array.from({ length: 60 }, (_, i) =>
        createThinkingLog(`Message ${i}`, `2024-01-01T10:00:${String(i).padStart(2, "0")}Z`)
      );
      render(<ConversationLogViewer logs={logs} initialLimit={10} />);

      // Should show first 10 and a "Show more" button
      expect(screen.getByText("Message 0")).toBeInTheDocument();
      expect(screen.getByText("Message 9")).toBeInTheDocument();
      expect(screen.queryByText("Message 10")).not.toBeInTheDocument();
      expect(screen.getByText(/Show more.*50 remaining/)).toBeInTheDocument();
    });

    it("loads more events on click", () => {
      const logs = Array.from({ length: 60 }, (_, i) =>
        createThinkingLog(`Message ${i}`, `2024-01-01T10:00:${String(i).padStart(2, "0")}Z`)
      );
      render(<ConversationLogViewer logs={logs} initialLimit={10} />);

      fireEvent.click(screen.getByText(/Show more/));

      // Should now show more events
      expect(screen.getByText("Message 10")).toBeInTheDocument();
    });
  });

  describe("mixed content", () => {
    it("displays full conversation flow", () => {
      const logs = [
        createSessionStartLog("claude-3-opus", "2024-01-01T10:00:00Z"),
        createThinkingLog("Let me check that file...", "2024-01-01T10:00:01Z"),
        createToolCallLog("Read", { file_path: "/src/main.ts" }, "2024-01-01T10:00:02Z"),
        createSessionEndLog(3000, 5, 0.02, "2024-01-01T10:00:03Z"),
      ];

      render(<ConversationLogViewer logs={logs} />);

      expect(screen.getByText("Session Started")).toBeInTheDocument();
      expect(screen.getByText("Let me check that file...")).toBeInTheDocument();
      expect(screen.getByText("Read")).toBeInTheDocument();
      expect(screen.getByText("Session Complete")).toBeInTheDocument();
    });
  });
});

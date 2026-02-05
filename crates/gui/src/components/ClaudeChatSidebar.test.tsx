import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ClaudeChatSidebar } from "./ClaudeChatSidebar";
import type { ChatMessage } from "../hooks/useClaudeChat";

// Mock scrollIntoView which is not available in jsdom
Element.prototype.scrollIntoView = vi.fn();

// Mock the stores
const mockUIStore = {
  claudeSidebarOpen: true,
  toggleClaudeSidebar: vi.fn(),
};

vi.mock("../stores", () => ({
  useUIStore: vi.fn((selector) => selector(mockUIStore)),
}));

// Mock useClaudeChat hook
const mockUseClaudeChat = {
  messages: [] as ChatMessage[],
  state: "idle" as "idle" | "starting" | "running" | "ended" | "error",
  error: null as string | null,
  contextUsage: null as { tokens: number; window: number; percentage: number } | null,
  startSession: vi.fn(),
  sendMessage: vi.fn(),
  closeSession: vi.fn(),
  clearMessages: vi.fn(),
  isActive: false,
  hasEnded: false,
};

vi.mock("../hooks/useClaudeChat", () => ({
  useClaudeChat: vi.fn(() => mockUseClaudeChat),
}));

// Mock bindings
vi.mock("../bindings", () => ({
  commands: {
    getCurrentProjectPath: vi.fn().mockResolvedValue({
      status: "ok",
      data: "/test/project/path",
    }),
  },
}));

describe("ClaudeChatSidebar", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Reset mock state
    mockUIStore.claudeSidebarOpen = true;
    mockUseClaudeChat.messages = [];
    mockUseClaudeChat.state = "idle";
    mockUseClaudeChat.error = null;
    mockUseClaudeChat.contextUsage = null;
    mockUseClaudeChat.isActive = false;
    mockUseClaudeChat.hasEnded = false;
  });

  describe("rendering", () => {
    it("renders when sidebar is open", () => {
      render(<ClaudeChatSidebar />);
      expect(screen.getByText("Claude Chat")).toBeInTheDocument();
    });

    it("does not render when sidebar is closed", () => {
      mockUIStore.claudeSidebarOpen = false;
      render(<ClaudeChatSidebar />);
      expect(screen.queryByText("Claude Chat")).not.toBeInTheDocument();
    });

    it("shows empty state when no messages", () => {
      render(<ClaudeChatSidebar />);
      expect(
        screen.getByText("Start a conversation with Claude")
      ).toBeInTheDocument();
      expect(
        screen.getByText("Type a message and press Enter to begin")
      ).toBeInTheDocument();
    });

    it("shows working directory when loaded", async () => {
      render(<ClaudeChatSidebar />);
      await waitFor(() => {
        expect(
          screen.getByText("Working in: /test/project/path")
        ).toBeInTheDocument();
      });
    });
  });

  describe("session status indicators", () => {
    it("shows pulsing indicator when starting", () => {
      mockUseClaudeChat.state = "starting";
      render(<ClaudeChatSidebar />);
      // The pulsing animation is on the span
      const statusArea = screen.getByText("Claude Chat").parentElement;
      expect(statusArea?.querySelector(".animate-ping")).toBeInTheDocument();
    });

    it("shows green indicator when running", () => {
      mockUseClaudeChat.state = "running";
      mockUseClaudeChat.isActive = true;
      render(<ClaudeChatSidebar />);
      const statusArea = screen.getByText("Claude Chat").parentElement;
      expect(statusArea?.querySelector(".bg-success")).toBeInTheDocument();
    });

    it("shows muted indicator when ended", () => {
      mockUseClaudeChat.state = "ended";
      mockUseClaudeChat.hasEnded = true;
      render(<ClaudeChatSidebar />);
      const statusArea = screen.getByText("Claude Chat").parentElement;
      expect(statusArea?.querySelector(".bg-text-muted")).toBeInTheDocument();
    });

    it("shows error indicator when error state", () => {
      mockUseClaudeChat.state = "error";
      mockUseClaudeChat.error = "Test error";
      render(<ClaudeChatSidebar />);
      const statusArea = screen.getByText("Claude Chat").parentElement;
      expect(statusArea?.querySelector(".bg-error")).toBeInTheDocument();
    });
  });

  describe("context usage display", () => {
    it("shows context usage when available", () => {
      mockUseClaudeChat.contextUsage = {
        tokens: 10000,
        window: 200000,
        percentage: 5,
      };
      render(<ClaudeChatSidebar />);
      expect(screen.getByText("5%")).toBeInTheDocument();
    });

    it("applies warning color when usage > 50%", () => {
      mockUseClaudeChat.contextUsage = {
        tokens: 120000,
        window: 200000,
        percentage: 60,
      };
      render(<ClaudeChatSidebar />);
      const progressBar = screen.getByText("60%").previousElementSibling;
      expect(progressBar?.querySelector(".bg-warning")).toBeInTheDocument();
    });

    it("applies error color when usage > 80%", () => {
      mockUseClaudeChat.contextUsage = {
        tokens: 180000,
        window: 200000,
        percentage: 90,
      };
      render(<ClaudeChatSidebar />);
      const progressBar = screen.getByText("90%").previousElementSibling;
      expect(progressBar?.querySelector(".bg-error")).toBeInTheDocument();
    });
  });

  describe("message display", () => {
    it("renders user messages", () => {
      mockUseClaudeChat.messages = [
        { kind: "user", text: "Hello Claude", timestamp: new Date().toISOString() },
      ];
      render(<ClaudeChatSidebar />);
      expect(screen.getByText("Hello Claude")).toBeInTheDocument();
    });

    it("renders assistant messages", () => {
      mockUseClaudeChat.messages = [
        { kind: "assistant", text: "Hello! How can I help?", timestamp: new Date().toISOString() },
      ];
      render(<ClaudeChatSidebar />);
      expect(screen.getByText("Hello! How can I help?")).toBeInTheDocument();
    });

    it("renders tool call messages", () => {
      mockUseClaudeChat.messages = [
        {
          kind: "tool_call",
          toolName: "Read",
          toolId: "tool-1",
          input: '{"file": "test.ts"}',
          timestamp: new Date().toISOString(),
        },
      ];
      render(<ClaudeChatSidebar />);
      expect(screen.getByText("Read")).toBeInTheDocument();
      expect(screen.getByText('{"file": "test.ts"}')).toBeInTheDocument();
    });

    it("renders tool result messages", () => {
      mockUseClaudeChat.messages = [
        {
          kind: "tool_result",
          toolId: "tool-1",
          result: "File contents here",
          isError: false,
          timestamp: new Date().toISOString(),
        },
      ];
      render(<ClaudeChatSidebar />);
      expect(screen.getByText("Result")).toBeInTheDocument();
      expect(screen.getByText("File contents here")).toBeInTheDocument();
    });

    it("renders error tool results with error styling", () => {
      mockUseClaudeChat.messages = [
        {
          kind: "tool_result",
          toolId: "tool-1",
          result: "File not found",
          isError: true,
          timestamp: new Date().toISOString(),
        },
      ];
      render(<ClaudeChatSidebar />);
      expect(screen.getByText("Error")).toBeInTheDocument();
      expect(screen.getByText("File not found")).toBeInTheDocument();
    });

    it("renders permission request messages", () => {
      mockUseClaudeChat.messages = [
        {
          kind: "permission_request",
          toolName: "Bash",
          message: "Run command: ls -la",
          timestamp: new Date().toISOString(),
        },
      ];
      render(<ClaudeChatSidebar />);
      expect(screen.getByText("Permission Required")).toBeInTheDocument();
      expect(screen.getByText("Run command: ls -la")).toBeInTheDocument();
    });

    it("renders error messages", () => {
      mockUseClaudeChat.messages = [
        { kind: "error", message: "Connection lost", timestamp: new Date().toISOString() },
      ];
      render(<ClaudeChatSidebar />);
      expect(screen.getByText("Connection lost")).toBeInTheDocument();
    });

    it("does not render session_start messages", () => {
      mockUseClaudeChat.messages = [
        { kind: "session_start", model: "claude-3-sonnet", timestamp: new Date().toISOString() },
      ];
      render(<ClaudeChatSidebar />);
      expect(screen.queryByText("claude-3-sonnet")).not.toBeInTheDocument();
    });

    it("does not render session_end messages", () => {
      mockUseClaudeChat.messages = [
        {
          kind: "session_end",
          durationMs: 5000,
          costUsd: 0.05,
          numTurns: 3,
          timestamp: new Date().toISOString(),
        },
      ];
      render(<ClaudeChatSidebar />);
      expect(screen.queryByText("5000")).not.toBeInTheDocument();
    });
  });

  describe("input handling", () => {
    it("starts session with Enter when idle", async () => {
      const user = userEvent.setup();
      render(<ClaudeChatSidebar />);

      const input = screen.getByPlaceholderText("Type a message to start...");
      await user.type(input, "Hello Claude{Enter}");

      expect(mockUseClaudeChat.startSession).toHaveBeenCalledWith("Hello Claude");
    });

    it("sends message with Enter when active", async () => {
      mockUseClaudeChat.state = "running";
      mockUseClaudeChat.isActive = true;

      const user = userEvent.setup();
      render(<ClaudeChatSidebar />);

      const input = screen.getByPlaceholderText("Type a message...");
      await user.type(input, "Hello{Enter}");

      expect(mockUseClaudeChat.sendMessage).toHaveBeenCalledWith("Hello");
    });

    it("does not send on Shift+Enter (allows multiline)", async () => {
      mockUseClaudeChat.state = "running";
      mockUseClaudeChat.isActive = true;

      const user = userEvent.setup();
      render(<ClaudeChatSidebar />);

      const input = screen.getByPlaceholderText("Type a message...");
      await user.type(input, "Hello{Shift>}{Enter}{/Shift}World");

      expect(mockUseClaudeChat.sendMessage).not.toHaveBeenCalled();
    });

    it("disables input when starting", () => {
      mockUseClaudeChat.state = "starting";
      render(<ClaudeChatSidebar />);

      const input = screen.getByPlaceholderText("Type a message to start...");
      expect(input).toBeDisabled();
    });

    it("clears input after starting session", async () => {
      const user = userEvent.setup();
      render(<ClaudeChatSidebar />);

      const input = screen.getByPlaceholderText("Type a message to start...");
      await user.type(input, "Hello Claude{Enter}");

      expect(input).toHaveValue("");
    });

    it("clears input after sending message", async () => {
      mockUseClaudeChat.state = "running";
      mockUseClaudeChat.isActive = true;

      const user = userEvent.setup();
      render(<ClaudeChatSidebar />);

      const input = screen.getByPlaceholderText("Type a message...");
      await user.type(input, "Hello{Enter}");

      expect(input).toHaveValue("");
    });
  });

  describe("control buttons", () => {
    it("shows close session button when active", () => {
      mockUseClaudeChat.state = "running";
      mockUseClaudeChat.isActive = true;
      render(<ClaudeChatSidebar />);

      expect(screen.getByTitle("Close session")).toBeInTheDocument();
    });

    it("hides close session button when not active", () => {
      mockUseClaudeChat.state = "idle";
      mockUseClaudeChat.isActive = false;
      render(<ClaudeChatSidebar />);

      expect(screen.queryByTitle("Close session")).not.toBeInTheDocument();
    });

    it("calls closeSession when close button clicked", async () => {
      mockUseClaudeChat.state = "running";
      mockUseClaudeChat.isActive = true;

      const user = userEvent.setup();
      render(<ClaudeChatSidebar />);

      await user.click(screen.getByTitle("Close session"));
      expect(mockUseClaudeChat.closeSession).toHaveBeenCalled();
    });

    it("calls clearMessages when clear button clicked", async () => {
      const user = userEvent.setup();
      render(<ClaudeChatSidebar />);

      await user.click(screen.getByTitle("Clear messages"));
      expect(mockUseClaudeChat.clearMessages).toHaveBeenCalled();
    });

    it("calls toggleClaudeSidebar when close panel button clicked", async () => {
      const user = userEvent.setup();
      render(<ClaudeChatSidebar />);

      await user.click(screen.getByTitle("Close panel"));
      expect(mockUIStore.toggleClaudeSidebar).toHaveBeenCalled();
    });
  });

  describe("error state", () => {
    it("shows error message when in error state", () => {
      mockUseClaudeChat.state = "error";
      mockUseClaudeChat.error = "Failed to connect";
      render(<ClaudeChatSidebar />);

      expect(screen.getByText("Session error: Failed to connect")).toBeInTheDocument();
    });

    it("shows start new session link on error", () => {
      mockUseClaudeChat.state = "error";
      mockUseClaudeChat.error = "Failed to connect";
      render(<ClaudeChatSidebar />);

      expect(screen.getByText("Start new session")).toBeInTheDocument();
    });

    it("calls startSession when start new session clicked", async () => {
      mockUseClaudeChat.state = "error";
      mockUseClaudeChat.error = "Failed to connect";

      const user = userEvent.setup();
      render(<ClaudeChatSidebar />);

      await user.click(screen.getByText("Start new session"));
      expect(mockUseClaudeChat.startSession).toHaveBeenCalled();
    });
  });

  describe("send button", () => {
    it("shows spinner when starting", () => {
      mockUseClaudeChat.state = "starting";
      render(<ClaudeChatSidebar />);

      const button = screen.getByRole("button", { name: /start session/i });
      expect(button.querySelector(".animate-spin")).toBeInTheDocument();
    });

    it("is disabled when no input and not active", () => {
      render(<ClaudeChatSidebar />);

      const button = screen.getByRole("button", { name: /start session/i });
      expect(button).toBeDisabled();
    });

    it("is enabled when there is input", async () => {
      const user = userEvent.setup();
      render(<ClaudeChatSidebar />);

      const input = screen.getByPlaceholderText("Type a message to start...");
      await user.type(input, "Hello");

      const button = screen.getByRole("button", { name: /start session/i });
      expect(button).not.toBeDisabled();
    });

    it("starts session on click when idle with input", async () => {
      const user = userEvent.setup();
      render(<ClaudeChatSidebar />);

      const input = screen.getByPlaceholderText("Type a message to start...");
      await user.type(input, "Hello");

      const button = screen.getByRole("button", { name: /start session/i });
      await user.click(button);

      expect(mockUseClaudeChat.startSession).toHaveBeenCalledWith("Hello");
    });

    it("sends message on click when active", async () => {
      mockUseClaudeChat.state = "running";
      mockUseClaudeChat.isActive = true;

      const user = userEvent.setup();
      render(<ClaudeChatSidebar />);

      const input = screen.getByPlaceholderText("Type a message...");
      await user.type(input, "Hello");

      const button = screen.getByRole("button", { name: /send message/i });
      await user.click(button);

      expect(mockUseClaudeChat.sendMessage).toHaveBeenCalledWith("Hello");
    });
  });
});

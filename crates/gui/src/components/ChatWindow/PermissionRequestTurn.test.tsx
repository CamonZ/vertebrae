import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { PermissionRequestTurn } from "./PermissionRequestTurn";
import { commands } from "../../bindings";
import type { ChatMessage } from "../../stores/chatStore";

vi.mock("../../bindings", () => ({
  commands: {
    resolvePermissionRequest: vi.fn(),
  },
}));

const mockedCommands = vi.mocked(commands);

function createPermissionMessage(
  overrides: Partial<
    Extract<ChatMessage, { kind: "permission_request" }>
  > = {}
): Extract<ChatMessage, { kind: "permission_request" }> {
  return {
    kind: "permission_request",
    requestId: "req-1",
    toolName: "Write",
    message: "Write to /test/file.ts",
    input: '{"content": "hello"}',
    timestamp: "2024-01-01T12:00:00Z",
    ...overrides,
  };
}

describe("PermissionRequestTurn", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("renders the tool name and message", () => {
    render(<PermissionRequestTurn message={createPermissionMessage()} />);
    expect(screen.getByText("Write")).toBeInTheDocument();
    expect(screen.getByText("Write to /test/file.ts")).toBeInTheDocument();
  });

  it("renders the 'Permission required' label", () => {
    render(<PermissionRequestTurn message={createPermissionMessage()} />);
    expect(screen.getByText("Permission required")).toBeInTheDocument();
  });

  it("shows Approve and Deny buttons", () => {
    render(<PermissionRequestTurn message={createPermissionMessage()} />);
    expect(screen.getByText("Approve")).toBeInTheDocument();
    expect(screen.getByText("Deny")).toBeInTheDocument();
  });

  it("renders the editable input textarea when input is provided", () => {
    render(<PermissionRequestTurn message={createPermissionMessage()} />);
    const textarea = screen.getByRole("textbox");
    expect(textarea).toHaveValue('{"content": "hello"}');
  });

  it("does not render a textarea when input is absent", () => {
    const message = createPermissionMessage({ input: undefined });
    render(<PermissionRequestTurn message={message} />);
    expect(screen.queryByRole("textbox")).not.toBeInTheDocument();
  });

  it("calls resolvePermissionRequest with allow when Approve is clicked", async () => {
    mockedCommands.resolvePermissionRequest.mockResolvedValue({
      status: "ok",
      data: null,
    });
    render(<PermissionRequestTurn message={createPermissionMessage()} />);

    fireEvent.click(screen.getByText("Approve"));

    await waitFor(() => {
      expect(mockedCommands.resolvePermissionRequest).toHaveBeenCalledWith({
        request_id: "req-1",
        behavior: "allow",
        message: null,
        updated_input: { content: "hello" },
      });
    });
  });

  it("calls resolvePermissionRequest with deny when Deny is clicked", async () => {
    mockedCommands.resolvePermissionRequest.mockResolvedValue({
      status: "ok",
      data: null,
    });
    render(<PermissionRequestTurn message={createPermissionMessage()} />);

    fireEvent.click(screen.getByText("Deny"));

    await waitFor(() => {
      expect(mockedCommands.resolvePermissionRequest).toHaveBeenCalledWith({
        request_id: "req-1",
        behavior: "deny",
        message: "Denied from Vertebrae GUI",
        updated_input: null,
      });
    });
  });

  it("shows Resolved text after successful approval", async () => {
    mockedCommands.resolvePermissionRequest.mockResolvedValue({
      status: "ok",
      data: null,
    });
    render(<PermissionRequestTurn message={createPermissionMessage()} />);

    fireEvent.click(screen.getByText("Approve"));

    await waitFor(() => {
      expect(screen.getByText("Resolved")).toBeInTheDocument();
    });
  });

  it("shows error message when approval fails", async () => {
    mockedCommands.resolvePermissionRequest.mockResolvedValue({
      status: "error",
      error: { message: "Backend rejected" },
    });
    render(<PermissionRequestTurn message={createPermissionMessage()} />);

    fireEvent.click(screen.getByText("Approve"));

    await waitFor(() => {
      expect(screen.getByText("Backend rejected")).toBeInTheDocument();
    });
  });

  it("shows error when updated input is invalid JSON", async () => {
    render(<PermissionRequestTurn message={createPermissionMessage()} />);

    const textarea = screen.getByRole("textbox");
    fireEvent.change(textarea, { target: { value: "{invalid json" } });
    fireEvent.click(screen.getByText("Approve"));

    await waitFor(() => {
      // JSON parse error message varies by runtime; just verify error is shown
      const errorEl = document.querySelector(".text-\\[var\\(--color-err\\)\\]");
      expect(errorEl).toBeInTheDocument();
    });
    expect(mockedCommands.resolvePermissionRequest).not.toHaveBeenCalled();
  });

  it("shows error when updated input is a JSON array instead of an object", async () => {
    render(<PermissionRequestTurn message={createPermissionMessage()} />);

    const textarea = screen.getByRole("textbox");
    fireEvent.change(textarea, { target: { value: "[1, 2, 3]" } });
    fireEvent.click(screen.getByText("Approve"));

    await waitFor(() => {
      expect(
        screen.getByText("Updated input must be a JSON object")
      ).toBeInTheDocument();
    });
    expect(mockedCommands.resolvePermissionRequest).not.toHaveBeenCalled();
  });

  it("disables buttons while approving", async () => {
    const pendingPromise = new Promise<{ status: "ok"; data: null }>(() => {
      // Never resolves during the test; we unblock manually below.
    });
    mockedCommands.resolvePermissionRequest.mockReturnValue(pendingPromise);

    render(<PermissionRequestTurn message={createPermissionMessage()} />);

    fireEvent.click(screen.getByText("Approve"));

    await waitFor(() => {
      expect(screen.getByText("Approving...")).toBeDisabled();
    });
    expect(screen.getByText("Deny")).toBeDisabled();
  });

  it("starts in resolved state when requestId is absent", () => {
    const message = createPermissionMessage({ requestId: undefined });
    render(<PermissionRequestTurn message={message} />);
    expect(screen.getByText("Resolved")).toBeInTheDocument();
    expect(screen.getByText("Approve")).toBeDisabled();
    expect(screen.getByText("Deny")).toBeDisabled();
  });

  it("sends empty object when input is cleared before approving", async () => {
    mockedCommands.resolvePermissionRequest.mockResolvedValue({
      status: "ok",
      data: null,
    });
    render(<PermissionRequestTurn message={createPermissionMessage()} />);

    const textarea = screen.getByRole("textbox");
    fireEvent.change(textarea, { target: { value: "" } });
    fireEvent.click(screen.getByText("Approve"));

    await waitFor(() => {
      expect(mockedCommands.resolvePermissionRequest).toHaveBeenCalledWith({
        request_id: "req-1",
        behavior: "allow",
        message: null,
        updated_input: {},
      });
    });
  });

  // --- Mutation-killing tests ---

  it("trims whitespace-only input before parsing on approve", async () => {
    mockedCommands.resolvePermissionRequest.mockResolvedValue({
      status: "ok",
      data: null,
    });
    render(<PermissionRequestTurn message={createPermissionMessage()} />);

    const textarea = screen.getByRole("textbox");
    fireEvent.change(textarea, { target: { value: "   " } });
    fireEvent.click(screen.getByText("Approve"));

    await waitFor(() => {
      expect(mockedCommands.resolvePermissionRequest).toHaveBeenCalledWith({
        request_id: "req-1",
        behavior: "allow",
        message: null,
        updated_input: {},
      });
    });
  });

  it("sets status to 'denying' and shows 'Denying...' while deny is in flight", async () => {
    const pendingPromise = new Promise<{ status: "ok"; data: null }>(() => {});
    mockedCommands.resolvePermissionRequest.mockReturnValue(pendingPromise);

    render(<PermissionRequestTurn message={createPermissionMessage()} />);

    fireEvent.click(screen.getByText("Deny"));

    await waitFor(() => {
      expect(screen.getByText("Denying...")).toBeDisabled();
    });
    expect(screen.getByText("Approve")).toBeDisabled();
  });

  it("shows Resolved text after successful denial", async () => {
    mockedCommands.resolvePermissionRequest.mockResolvedValue({
      status: "ok",
      data: null,
    });
    render(<PermissionRequestTurn message={createPermissionMessage()} />);

    fireEvent.click(screen.getByText("Deny"));

    await waitFor(() => {
      expect(screen.getByText("Resolved")).toBeInTheDocument();
    });
  });

  it("does not show an error element when there is no error", () => {
    render(<PermissionRequestTurn message={createPermissionMessage()} />);
    // The error paragraph is distinct from buttons; check for the <p> tag
    // with the error class (the Deny button also has this class).
    const errorParagraphs = document.querySelectorAll(
      "p.text-\\[var\\(--color-err\\)\\]"
    );
    expect(errorParagraphs).toHaveLength(0);
  });

  it("disables both buttons while denying", async () => {
    const pendingPromise = new Promise<{ status: "ok"; data: null }>(() => {});
    mockedCommands.resolvePermissionRequest.mockReturnValue(pendingPromise);

    render(<PermissionRequestTurn message={createPermissionMessage()} />);

    fireEvent.click(screen.getByText("Deny"));

    await waitFor(() => {
      expect(screen.getByText("Approve")).toBeDisabled();
    });
    expect(screen.getByText("Denying...")).toBeDisabled();
  });

  it("does not show Resolved text in the initial pending state", () => {
    render(<PermissionRequestTurn message={createPermissionMessage()} />);
    expect(screen.queryByText("Resolved")).not.toBeInTheDocument();
  });

  it("sends error message when denying", async () => {
    mockedCommands.resolvePermissionRequest.mockResolvedValue({
      status: "ok",
      data: null,
    });
    render(<PermissionRequestTurn message={createPermissionMessage()} />);

    fireEvent.click(screen.getByText("Deny"));

    await waitFor(() => {
      const call = mockedCommands.resolvePermissionRequest.mock.calls[0][0];
      expect(call.message).toBe("Denied from Vertebrae GUI");
    });
  });

  it("shows Approving... label while allow is in flight", async () => {
    const pendingPromise = new Promise<{ status: "ok"; data: null }>(() => {});
    mockedCommands.resolvePermissionRequest.mockReturnValue(pendingPromise);

    render(<PermissionRequestTurn message={createPermissionMessage()} />);

    fireEvent.click(screen.getByText("Approve"));

    await waitFor(() => {
      expect(screen.getByText("Approving...")).toBeInTheDocument();
    });
  });

  it("has spellcheck disabled on the input textarea", () => {
    render(<PermissionRequestTurn message={createPermissionMessage()} />);
    const textarea = screen.getByRole("textbox");
    expect(textarea).toHaveAttribute("spellcheck", "false");
  });
});

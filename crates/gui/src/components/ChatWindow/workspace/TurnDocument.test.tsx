import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, expect, it, vi } from "vitest";
import { commands } from "../../../bindings";
import { useState } from "react";
import { useToolAnnotation } from "../../../hooks/useToolAnnotation";
import { annotationWorktree } from "../../../stores/toolAnnotations";
import { useChatStore } from "../../../stores/chatStore";
import { TurnDocument, type TurnDocumentVersion } from "./TurnDocument";

vi.mock("../../../bindings", () => ({
  commands: {
    readChatHistoryFile: vi.fn(),
    readWorktreeFile: vi.fn(),
    worktreeFileExists: vi.fn(),
  },
}));
vi.mock("./SourceEvidenceCode", () => ({
  default: ({ source }: { source: { contents: string } }) => (
    <pre>{source.contents}</pre>
  ),
}));
vi.mock("./OpenInExternalEditor", () => ({
  OpenInExternalEditor: () => <button>Open in external editor</button>,
}));
const target = {
  path: "a.ts",
  reveal: null,
  history: { sessionId: "chat", turnId: "one" },
};

function Document({ checkout }: { checkout: string }) {
  const [version, setVersion] = useState<TurnDocumentVersion>("turn");
  const capture = useToolAnnotation(
    "chat",
    '["turn","one"]',
    "worktree_history"
  );
  const origin = useToolAnnotation("chat", '["turn","one"]', "worktree_origin");
  return (
    <TurnDocument
      target={{
        ...target,
        root:
          annotationWorktree(origin) ?? annotationWorktree(capture) ?? checkout,
      }}
      version={version}
      onVersionChange={setVersion}
      onClose={() => {}}
    />
  );
}

beforeEach(() => {
  vi.resetAllMocks();
  useChatStore.setState({ sessions: {} });
  vi.mocked(commands.readChatHistoryFile).mockResolvedValue({
    status: "ok",
    data: { kind: "text", contents: "historical contents", revision: "old" },
  });
  vi.mocked(commands.readWorktreeFile).mockResolvedValue({
    status: "ok",
    data: { kind: "missing" },
  });
});

it("defaults to the recorded turn, and requires an explicit action to show the latest deleted file", async () => {
  render(<Document checkout="/feature" />);
  expect(await screen.findByText("historical contents")).toBeInTheDocument();
  expect(commands.readWorktreeFile).not.toHaveBeenCalled();
  expect(screen.queryByText("Open in external editor")).not.toBeInTheDocument();

  await userEvent.click(screen.getByRole("radio", { name: "Latest file" }));
  expect(
    await screen.findByText("This file no longer exists in its worktree.")
  ).toBeInTheDocument();
  expect(commands.readWorktreeFile).toHaveBeenCalledExactlyOnceWith(
    "/feature",
    "a.ts"
  );

  await userEvent.click(screen.getByRole("radio", { name: "At this turn" }));
  expect(await screen.findByText("historical contents")).toBeInTheDocument();
});

it("does not let a late historical response replace the explicitly selected latest version", async () => {
  let finish!: (
    value: Awaited<ReturnType<typeof commands.readChatHistoryFile>>
  ) => void;
  vi.mocked(commands.readChatHistoryFile).mockReturnValue(
    new Promise((resolve) => {
      finish = resolve;
    })
  );
  vi.mocked(commands.readWorktreeFile).mockResolvedValue({
    status: "ok",
    data: { kind: "text", contents: "latest contents", revision: "new" },
  });
  render(<Document checkout="/feature" />);
  await userEvent.click(screen.getByRole("radio", { name: "Latest file" }));
  expect(await screen.findByText("latest contents")).toBeInTheDocument();

  await act(async () =>
    finish({
      status: "ok",
      data: { kind: "text", contents: "stale contents", revision: "old" },
    })
  );
  expect(screen.getByText("latest contents")).toBeInTheDocument();
  expect(screen.queryByText("stale contents")).not.toBeInTheDocument();
});

it("retries explicitly after a historical storage failure without falling back", async () => {
  vi.mocked(commands.readChatHistoryFile).mockRejectedValueOnce(
    new Error("Storage unavailable")
  );
  render(<Document checkout="/feature" />);
  expect(await screen.findByText("Storage unavailable")).toHaveTextContent(
    "Storage unavailable"
  );
  await userEvent.click(screen.getByRole("button", { name: "Retry" }));
  await waitFor(() =>
    expect(screen.getByText("historical contents")).toBeInTheDocument()
  );
  expect(commands.readWorktreeFile).not.toHaveBeenCalled();
});

it("offers retry for the normal command-error result", async () => {
  vi.mocked(commands.readChatHistoryFile).mockResolvedValueOnce({
    status: "error",
    error: { message: "Repository temporarily unavailable" },
  });
  render(<Document checkout="/feature" />);
  expect(
    await screen.findByText("Repository temporarily unavailable")
  ).toBeInTheDocument();
  await userEvent.click(screen.getByRole("button", { name: "Retry" }));
  expect(await screen.findByText("historical contents")).toBeInTheDocument();
});

it("keeps unknown latest unavailable, then follows the original identity when its annotation arrives", async () => {
  useChatStore.setState({
    sessions: {
      chat: {
        id: "chat",
        label: "test",
        harness: "codex",
        status: "open",
        backendSessionId: null,
        providerResumeId: null,
        messages: [],
        association: {
          ticketId: null,
          ticketTitle: null,
          worktreePath: "/later",
          branch: "later",
          lastProcessedAt: null,
          processedAtCount: 0,
          awaitingWorktree: null,
          recentWorktrees: [],
        },
      },
    },
  });
  vi.mocked(commands.readChatHistoryFile).mockResolvedValue({
    status: "ok",
    data: {
      error: {
        kind: "not_captured",
        message: "Capture pending",
        retryable: true,
      },
    },
  });
  render(<Document checkout="" />);
  await screen.findByText("Capture pending");
  await userEvent.click(screen.getByRole("radio", { name: "Latest file" }));
  expect(
    await screen.findByText(
      "The original checkout was not recorded for this reference."
    )
  ).toBeInTheDocument();
  expect(commands.readWorktreeFile).not.toHaveBeenCalled();
  act(() =>
    useChatStore.getState().applyToolAnnotation("chat", {
      session_id: "chat",
      tool_id: "",
      subject: { kind: "turn", id: "one" },
      kind: "worktree_origin",
      recorded_at: "now",
      payload: { worktree: "/original", epoch: "epoch-a" },
    })
  );
  await waitFor(() =>
    expect(commands.readWorktreeFile).toHaveBeenCalledWith("/original", "a.ts")
  );
  expect(commands.readWorktreeFile).not.toHaveBeenCalledWith(
    "/later",
    expect.anything()
  );
});

it("corrects an already-open panel's latest root when historical identity arrives", async () => {
  useChatStore.setState({
    sessions: {
      chat: {
        id: "chat",
        label: "test",
        harness: "codex",
        status: "open",
        backendSessionId: null,
        providerResumeId: null,
        messages: [],
      },
    },
  });
  render(<Document checkout="/stale" />);
  await screen.findByText("historical contents");
  act(() =>
    useChatStore.getState().applyToolAnnotation("chat", {
      session_id: "chat",
      tool_id: "",
      subject: { kind: "turn", id: "one" },
      kind: "worktree_history",
      recorded_at: "now",
      payload: { worktree: "/original", state: "ready" },
    })
  );
  await userEvent.click(screen.getByRole("radio", { name: "Latest file" }));
  await waitFor(() =>
    expect(commands.readWorktreeFile).toHaveBeenCalledWith("/original", "a.ts")
  );
  expect(commands.readWorktreeFile).not.toHaveBeenCalledWith(
    "/stale",
    expect.anything()
  );
});

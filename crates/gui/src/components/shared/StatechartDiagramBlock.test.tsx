import type { ReactNode } from "react";
import { useChatStore } from "../../stores/chatStore";
import { ChatSessionContext } from "../thread/toolChange/ChatSessionContext";
import {
  act,
  cleanup,
  fireEvent,
  render as renderDom,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { MarkdownContent } from "./MarkdownContent";
import { queryClient } from "../../query/queryClient";
import { resetProjectScopedStores } from "../../stores/projectScopedStores";
import type { Artifact } from "../../bindings";

const save = vi.hoisted(() => vi.fn());
const list = vi.hoisted(() => vi.fn());
vi.mock("../../bindings", () => ({
  commands: { saveStatechartArtifact: save, listArtifactPresentations: list },
}));
vi.mock("./CodeSnippet", () => ({
  default: ({ source }: { source: string }) => <code>{source}</code>,
}));

const source = JSON.stringify({
  id: "delivery",
  initial: "Work",
  states: { Work: { on: { DONE: "Done" } }, Done: { type: "final" } },
});
const fence = (body = source) => `\`\`\`statechart\n${body}\n\`\`\``;
const artifact: Artifact = {
  id: "860cde1b-9093-42ff-a19d-7453f3b7891b",
  project_id: null,
  filename: "diagram.statechart.json",
  body: source,
  logical_name: null,
  metadata: {
    version: 1,
    content_kind: "statechart",
    format: "json",
    origin: "chat",
    presentation: "rendered",
    extensions: { statechart_format: "xstate-v5" },
  },
  created_at: null,
  updated_at: null,
};

const ticketId = "21e32ec0-1d73-4c72-afa5-cb955f9a2ab4";
let sessionId: string;
const association = (id: string | null = ticketId, entityLevel = "ticket") => ({
  ticketId: id,
  entityLevel,
  ticketTitle: "Chart ticket",
  worktreePath: null,
  branch: null,
  lastProcessedAt: null,
  processedAtCount: 0,
  awaitingWorktree: null,
  recentWorktrees: [],
});
function render(ui: ReactNode) {
  return renderDom(ui, {
    wrapper: ({ children }) => (
      <ChatSessionContext.Provider value={sessionId}>
        {children}
      </ChatSessionContext.Provider>
    ),
  });
}

beforeEach(() => {
  queryClient.clear();
  useChatStore.setState({ sessions: {} });
  sessionId = useChatStore.getState().openSession("Chart check");
  useChatStore.getState().setSessionAssociation(sessionId, association());
  save.mockReset().mockResolvedValue({ status: "ok", data: artifact });
  list.mockReset().mockResolvedValue({ status: "ok", data: [artifact] });
});
afterEach(() => {
  cleanup();
  queryClient.clear();
});

it("keeps a partial duplicate as code, then mounts it on closure", () => {
  const partial = `${fence()}\n\n\`\`\`statechart\n${source}`;
  const { rerender } = render(<MarkdownContent text={partial} />);
  expect(screen.getAllByTestId("statechart-preview")).toHaveLength(1);
  rerender(<MarkdownContent text={`${partial}\n\`\`\``} />);
  expect(screen.getAllByTestId("statechart-preview")).toHaveLength(2);
});

it.each(["{", '{"id":"bad","initial":"missing","states":{"Work":{}}}'])(
  "diagnoses invalid source inline: %s",
  (body) => {
    render(<MarkdownContent text={fence(body)} />);
    expect(screen.getByRole("alert")).toHaveTextContent(
      "Unable to render statechart:"
    );
    expect(
      screen.queryByRole("button", { name: "Save as artifact" })
    ).not.toBeInTheDocument();
  }
);

it.each(["dark", "light"])(
  "mounts the interactive preview in %s and retains controls as text streams",
  async (theme) => {
    document.documentElement.classList.toggle("light", theme === "light");
    const { rerender } = render(<MarkdownContent text={fence()} />);
    const colors = await screen.findByRole("combobox", {
      name: "Transition colors",
    });
    fireEvent.change(colors, { target: { value: "single" } });
    rerender(<MarkdownContent text={`${fence()}\n\nMore streamed text`} />);
    expect(
      screen.getByRole("combobox", { name: "Transition colors" })
    ).toHaveValue("single");
    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: "Zoom in statechart" })
      ).toBeEnabled()
    );
    document.documentElement.classList.remove("light");
  }
);

it("saves the original source once and renders the saved artifact link", async () => {
  let resolve!: (value: unknown) => void;
  save.mockReturnValue(
    new Promise((done) => {
      resolve = done;
    })
  );
  render(<MarkdownContent text={fence()} />);
  fireEvent.click(screen.getByRole("button", { name: "Save as artifact" }));
  expect(screen.getByRole("button", { name: "Saving…" })).toBeDisabled();
  expect(save).toHaveBeenCalledExactlyOnceWith(source, ticketId);
  await act(async () => resolve({ status: "ok", data: artifact }));
  expect(
    screen.getByRole("link", { name: `Open artifact ${artifact.id}` })
  ).toHaveAttribute("data-vtb-entity-id", artifact.id);
  expect(screen.getAllByTestId("statechart-preview")).toHaveLength(1);
});

it.each(["command", "transport"])(
  "shows %s save failure and permits retry",
  async (kind) => {
    if (kind === "command")
      save.mockResolvedValueOnce({
        status: "error",
        error: { message: "Save failed" },
      });
    else save.mockRejectedValueOnce(new Error("Save failed"));
    render(<MarkdownContent text={fence()} />);
    fireEvent.click(screen.getByRole("button", { name: "Save as artifact" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Unable to save artifact: Save failed"
    );
    fireEvent.click(screen.getByRole("button", { name: "Save as artifact" }));
    await screen.findByText("Saved artifact");
    expect(save).toHaveBeenCalledTimes(2);
  }
);

it("retires a pending save when the project switches", async () => {
  let resolve!: (value: unknown) => void;
  save.mockReturnValue(
    new Promise((done) => {
      resolve = done;
    })
  );
  render(<MarkdownContent text={fence()} />);
  fireEvent.click(screen.getByRole("button", { name: "Save as artifact" }));
  act(() => resetProjectScopedStores());
  await act(async () => resolve({ status: "ok", data: artifact }));
  expect(screen.queryByText("Saved artifact")).not.toBeInTheDocument();
  expect(queryClient.getQueryCache().getAll()).toHaveLength(0);
});

it.each(["~~~", "````"])(
  "supports %s fences without rewriting their JSON",
  (delimiter) => {
    render(
      <MarkdownContent
        text={`${delimiter}statechart\n${source}\n${delimiter}`}
      />
    );
    expect(screen.getByTestId("statechart-preview")).toBeInTheDocument();
  }
);

it.each(["general", "epic", "task"])(
  "hides saving for %s conversations",
  (kind) => {
    useChatStore
      .getState()
      .setSessionAssociation(
        sessionId,
        association(
          kind === "general" ? null : ticketId,
          kind === "general" ? "ticket" : kind
        )
      );
    render(<MarkdownContent text={fence()} />);
    expect(screen.getByTestId("statechart-preview")).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Save as artifact" })
    ).not.toBeInTheDocument();
    expect(save).not.toHaveBeenCalled();
  }
);

it("hides saving outside conversation context", () => {
  renderDom(<MarkdownContent text={fence()} />);
  expect(screen.getByTestId("statechart-preview")).toBeInTheDocument();
  expect(
    screen.queryByRole("button", { name: "Save as artifact" })
  ).not.toBeInTheDocument();
});

it("resets a saved link when the conversation ticket changes", async () => {
  render(<MarkdownContent text={fence()} />);
  fireEvent.click(screen.getByRole("button", { name: "Save as artifact" }));
  await screen.findByText("Saved artifact");
  act(() =>
    useChatStore
      .getState()
      .setSessionAssociation(
        sessionId,
        association("a001bc77-964a-4106-9ced-3ee95b5b77f7")
      )
  );
  expect(screen.queryByText("Saved artifact")).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "Save as artifact" }));
  expect(save).toHaveBeenLastCalledWith(
    source,
    "a001bc77-964a-4106-9ced-3ee95b5b77f7"
  );
});

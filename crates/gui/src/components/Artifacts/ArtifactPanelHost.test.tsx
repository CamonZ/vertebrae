import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { invoke } from "@tauri-apps/api/core";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, useLocation } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Artifact } from "../../bindings";
import { useEntityPanelStore } from "../../stores/entityPanelStore";
import { usePanelFocusStore } from "../../stores/panelFocusStore";
import { useGlassPanel } from "../../hooks/useGlassPanel";
import { MarkdownContent } from "../shared/MarkdownContent";
import { ArtifactPanelHost } from "./ArtifactPanelHost";

const first = "11111111-1111-4111-8111-111111111111";
const second = "22222222-2222-4222-8222-222222222222";
const missing = "33333333-3333-4333-8333-333333333333";
const other = "44444444-4444-4444-8444-444444444444";
const project = "55555555-5555-4555-8555-555555555555";

function artifact(
  id: string,
  title: string,
  body: string,
  format = "markdown"
): Artifact {
  return {
    id,
    project_id: "fixture-project",
    filename: title,
    body,
    logical_name: null,
    metadata: {
      version: 1,
      content_kind: "document",
      format,
      presentation: "rendered",
      origin: "test",
      extensions: {},
    },
    created_at: null,
    updated_at: null,
  };
}

const report = artifact(first, "report.md", "## Markdown fixture");
const payload = artifact(
  second,
  "payload.json",
  '{"fixture":"JSON fixture"}',
  "json"
);
const unrelated = artifact(other, "other.md", "## Other ticket fixture");
const projectReport = artifact(project, "project.md", "## Project fixture");
const files = [report, payload, unrelated, projectReport];

async function expectJsonPreview() {
  await waitFor(() => {
    const code = screen
      .getByTestId("artifact-json-preview")
      .querySelector("diffs-container")?.shadowRoot;
    const lines = Array.from(code?.querySelectorAll("[data-line]") ?? []);
    expect(lines.map((line) => line.textContent).join("\n")).toContain(
      '"fixture": "JSON fixture"'
    );
  });
}

function deferredArtifact() {
  let resolve!: (artifact: Artifact) => void;
  const promise = new Promise<Artifact>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function ChatFixture() {
  const { pathname } = useLocation();
  const { focusProps } = useGlassPanel({
    id: "fixture-chat",
    isOpen: true,
    onClose: () => {},
  });
  const ticketOpen = useEntityPanelStore(
    (state) => state.selection?.type === "task"
  );
  return (
    <>
      <main aria-label="Fixture conversation" {...focusProps}>
        <output aria-label="Current page">{pathname}</output>
        <section aria-label="Conversation history">
          <MarkdownContent
            text={`[Report](vtb://artifact/${first}) [Payload](vtb://artifact/${second}) [Missing](vtb://artifact/${missing}) [Other](vtb://artifact/${other}) [Project](vtb://artifact/${project})`}
          />
        </section>
        <textarea aria-label="Message draft" />
      </main>
      {ticketOpen && <aside aria-label="Current ticket">Fixture ticket</aside>}
      <ArtifactPanelHost />
    </>
  );
}

describe("artifact links in the shared inspector", () => {
  let client: QueryClient;

  beforeEach(() => {
    client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    vi.mocked(invoke).mockReset();
    useEntityPanelStore.getState().reset();
    usePanelFocusStore.getState().reset();
  });

  afterEach(() => {
    cleanup();
    client.clear();
    useEntityPanelStore.getState().reset();
    usePanelFocusStore.getState().reset();
    vi.mocked(invoke).mockReset();
  });

  function renderChat() {
    const user = userEvent.setup();
    render(
      <QueryClientProvider client={client}>
        <MemoryRouter initialEntries={["/chat/fixture"]}>
          <ChatFixture />
        </MemoryRouter>
      </QueryClientProvider>
    );
    return user;
  }

  const link = (id: string) =>
    screen.getByRole("link", { name: `Open artifact ${id}` });

  it("shows attached Markdown and JSON and replaces the ticket for an unrelated project artifact", async () => {
    vi.mocked(invoke).mockImplementation(async (command, args) => {
      if (command === "list_task_artifacts") return [report, payload];
      if (command === "find_artifact_presentation") {
        return (
          files.find(
            (file) => file.id === (args as { artifactId: string }).artifactId
          ) ?? null
        );
      }
      return [];
    });
    useEntityPanelStore.getState().openTask("current-ticket");
    const user = renderChat();
    const history = screen.getByRole("region", {
      name: "Conversation history",
    });
    history.scrollTop = 164;
    await user.type(
      screen.getByRole("textbox", { name: "Message draft" }),
      "Unsent fixture"
    );

    await user.click(link(first));
    expect(
      await screen.findByRole("heading", { name: "Markdown fixture" })
    ).toBeInTheDocument();
    expect(screen.getByText("report.md")).toBeInTheDocument();
    expect(screen.getByTestId("artifact-inspector-panel")).toHaveAttribute(
      "data-above-chat",
      "true"
    );
    expect(
      screen.getByRole("complementary", { name: "Current ticket" })
    ).toBeInTheDocument();

    await user.click(link(second));
    await expectJsonPreview();
    expect(screen.getByText("payload.json")).toBeInTheDocument();
    // Clicking the already selected link from chat raises its inspector again.
    await user.click(link(second));
    await user.keyboard("{Escape}");
    await waitFor(() =>
      expect(screen.queryByText("payload.json")).not.toBeInTheDocument()
    );
    expect(
      screen.getByRole("complementary", { name: "Current ticket" })
    ).toBeInTheDocument();

    await user.click(link(project));
    expect(
      await screen.findByRole("heading", { name: "Project fixture" })
    ).toBeInTheDocument();
    await waitFor(() =>
      expect(
        screen.queryByRole("complementary", { name: "Current ticket" })
      ).not.toBeInTheDocument()
    );
    await user.click(
      screen.getByRole("button", { name: "Close artifact inspector" })
    );
    await waitFor(() =>
      expect(screen.queryByText("project.md")).not.toBeInTheDocument()
    );

    act(() => useEntityPanelStore.getState().openTask("current-ticket"));
    await user.click(link(other));
    expect(
      await screen.findByRole("heading", { name: "Other ticket fixture" })
    ).toBeInTheDocument();
    await waitFor(() =>
      expect(
        screen.queryByRole("complementary", { name: "Current ticket" })
      ).not.toBeInTheDocument()
    );
    expect(screen.getByLabelText("Current page")).toHaveTextContent(
      "/chat/fixture"
    );
    expect(screen.getByRole("textbox", { name: "Message draft" })).toHaveValue(
      "Unsent fixture"
    );
    expect(screen.getByRole("region", { name: "Conversation history" })).toBe(
      history
    );
    expect(history.scrollTop).toBe(164);
  });

  it("keeps the ticket and conversation accessible when an artifact is missing", async () => {
    vi.mocked(invoke).mockImplementation(async (command) =>
      command === "find_artifact_presentation" ? null : []
    );
    useEntityPanelStore.getState().openTask("current-ticket");
    const user = renderChat();

    await user.click(link(missing));

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "This artifact is missing or unavailable in the active project."
    );
    expect(
      screen.getByRole("complementary", { name: "Current ticket" })
    ).toBeInTheDocument();
    expect(
      screen.getByRole("main", { name: "Fixture conversation" })
    ).toBeInTheDocument();
    await user.click(
      screen.getByRole("button", { name: "Close artifact inspector" })
    );
    await waitFor(() =>
      expect(screen.queryByRole("alert")).not.toBeInTheDocument()
    );
  });

  it("keeps the newer preview when the prior artifact request finishes last", async () => {
    const a = deferredArtifact();
    const b = deferredArtifact();
    vi.mocked(invoke).mockImplementation((command, args) => {
      if (command !== "find_artifact_presentation") return Promise.resolve([]);
      return (args as { artifactId: string }).artifactId === first
        ? a.promise
        : b.promise;
    });
    const user = renderChat();

    await user.click(link(first));
    await waitFor(() =>
      expect(invoke).toHaveBeenCalledWith("find_artifact_presentation", {
        artifactId: first,
      })
    );
    await user.click(link(second));
    await waitFor(() =>
      expect(invoke).toHaveBeenCalledWith("find_artifact_presentation", {
        artifactId: second,
      })
    );
    b.resolve(payload);
    await expectJsonPreview();

    await act(async () => a.resolve(report));
    expect(screen.getByText("payload.json")).toBeInTheDocument();
    expect(
      screen.queryByRole("heading", { name: "Markdown fixture" })
    ).not.toBeInTheDocument();
    expect(
      screen.getAllByRole("button", { name: "Close artifact inspector" })
    ).toHaveLength(1);
    // Settle the mounted panel before retiring the isolated cache.
    fireEvent.keyDown(window, { key: "Escape" });
    await waitFor(() =>
      expect(screen.queryByText("payload.json")).not.toBeInTheDocument()
    );
  });
});

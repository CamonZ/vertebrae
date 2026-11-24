import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { invoke } from "@tauri-apps/api/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import type { Artifact } from "../bindings";

const { useProjectArtifacts } = vi.hoisted(() => ({
  useProjectArtifacts: vi.fn(),
}));

vi.mock("../hooks/useProjectArtifacts", () => ({ useProjectArtifacts }));
const { useTaskArtifacts } = vi.hoisted(() => ({ useTaskArtifacts: vi.fn() }));
vi.mock("../hooks/useTaskArtifacts", () => ({ useTaskArtifacts }));
vi.mock("../hooks/useShellHeader", () => ({ useShellHeader: vi.fn() }));

import { ArtifactPanelHost } from "../components/Artifacts/ArtifactPanelHost";
import { usePanelFocusStore } from "../stores/panelFocusStore";
import { ArtifactsPage } from "./ArtifactsPage";
import { useEntityPanelStore } from "../stores/entityPanelStore";

const artifact = (id: string, name: string): Artifact => ({
  id,
  project_id: "project-1",
  filename: `${name}.md`,
  body: `# ${name}`,
  logical_name: name,
  metadata: {
    version: 1,
    content_kind: "document",
    format: "markdown",
    origin: "test",
    presentation: "rendered",
    extensions: {},
  },
  created_at: null,
  updated_at: null,
});

describe("ArtifactsPage", () => {
  let client: QueryClient;
  function renderPage(path = "/artifacts") {
    return render(<ArtifactsPage />, {
      wrapper: ({ children }) => (
        <QueryClientProvider client={client}>
          <MemoryRouter initialEntries={[path]}>
            {children}
            <ArtifactPanelHost />
          </MemoryRouter>
        </QueryClientProvider>
      ),
    });
  }

  beforeEach(() => {
    client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    vi.mocked(invoke).mockImplementation(async (command, args) => {
      if (command !== "find_artifact_presentation") return [];
      return (
        useProjectArtifacts().artifacts.find(
          (file: Artifact) =>
            file.id === (args as { artifactId: string }).artifactId
        ) ?? null
      );
    });
    useProjectArtifacts.mockReset();
    useTaskArtifacts.mockReset();
    useTaskArtifacts.mockReturnValue({
      artifacts: [],
      isLoading: false,
      error: null,
      refetch: vi.fn(),
    });
    useEntityPanelStore.getState().reset();
    useProjectArtifacts.mockReturnValue({
      artifacts: [artifact("a-1", "First"), artifact("a-2", "Second")],
      isLoading: false,
      error: null,
    });
  });

  afterEach(() => {
    cleanup();
    client.clear();
    useEntityPanelStore.getState().reset();
    usePanelFocusStore.getState().reset();
    vi.mocked(invoke).mockReset();
  });

  it("opens and replaces the inspector from pointer or keyboard selection", async () => {
    renderPage();
    fireEvent.click(screen.getByRole("treeitem", { name: /First/i }));
    expect(
      await screen.findByText("First", {
        selector: "[data-testid=artifact-inspector-title]",
      })
    ).toBeInTheDocument();

    fireEvent.keyDown(screen.getByRole("tree"), { key: "ArrowDown" });
    await waitFor(() =>
      expect(screen.getByTestId("artifact-inspector-title")).toHaveTextContent(
        "Second"
      )
    );
    expect(screen.getByRole("treeitem", { name: /Second/i })).toHaveAttribute(
      "aria-selected",
      "true"
    );
  });

  it("resolves a legacy artifact URL independently of the project list", async () => {
    useProjectArtifacts.mockReturnValue({
      artifacts: [],
      isLoading: true,
      error: null,
    });
    vi.mocked(invoke).mockResolvedValue(artifact("a-2", "Second"));
    renderPage("/artifacts?artifactId=a-2");

    await waitFor(() =>
      expect(screen.getByTestId("artifact-inspector-title")).toHaveTextContent(
        "Second"
      )
    );
  });

  it("shows the total on All and filters the list by artifact type", () => {
    const json: Artifact = {
      ...artifact("a-3", "Payload"),
      filename: "Payload.json",
      metadata: { ...artifact("a-3", "Payload").metadata!, format: "json" },
    };
    useProjectArtifacts.mockReturnValue({
      artifacts: [artifact("a-1", "First"), artifact("a-2", "Second"), json],
      isLoading: false,
      error: null,
    });
    renderPage();

    const filter = within(screen.getByTestId("artifacts-type-filter"));
    expect(
      filter.getAllByRole("button").map((chip) => chip.textContent)
    ).toEqual(["All3", "Markdown2", "JSON1"]);

    fireEvent.click(filter.getByRole("button", { name: /^JSON/ }));
    expect(
      screen.getByRole("treeitem", { name: /Payload/ })
    ).toBeInTheDocument();
    expect(screen.queryByRole("treeitem", { name: /First/ })).toBeNull();

    fireEvent.click(filter.getByRole("button", { name: /^JSON/ }));
    expect(screen.getByRole("treeitem", { name: /First/ })).toBeInTheDocument();
  });

  it("closes only the artifact inspector", async () => {
    renderPage();
    fireEvent.click(screen.getByRole("treeitem", { name: /First/i }));
    fireEvent.click(screen.getByTestId("artifact-inspector-close"));
    expect(screen.queryByTestId("artifact-inspector-panel")).toHaveAttribute(
      "data-closing",
      "true"
    );
  });

  it("renders loading, empty, and error list states", () => {
    useProjectArtifacts.mockReturnValueOnce({
      artifacts: [],
      isLoading: true,
      error: null,
    });
    const { rerender } = renderPage();
    expect(screen.getByLabelText("Loading artifacts")).toBeInTheDocument();

    useProjectArtifacts.mockReturnValueOnce({
      artifacts: [],
      isLoading: false,
      error: null,
    });
    rerender(<ArtifactsPage />);
    expect(screen.getByText("No project artifacts yet")).toBeInTheDocument();

    useProjectArtifacts.mockReturnValueOnce({
      artifacts: [],
      isLoading: false,
      error: "No service",
    });
    rerender(<ArtifactsPage />);
    expect(screen.getByRole("alert")).toHaveTextContent("No service");
  });

  it("renders accessible folders and keeps folder toggles separate from selection", async () => {
    useProjectArtifacts.mockReturnValue({
      artifacts: [
        artifact("a-1", "reports/summary.md"),
        artifact("a-2", "reports/detail.md"),
        artifact("a-3", "root.md"),
      ],
      isLoading: false,
      error: null,
    });
    renderPage();

    const folder = screen.getByTestId("artifact-tree-folder-folder:reports");
    expect(folder).toHaveAttribute("role", "treeitem");
    expect(folder).toHaveAttribute("aria-level", "1");
    expect(folder).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByTestId("artifact-tree-leaf-a-1")).toHaveAttribute(
      "aria-level",
      "2"
    );
    expect(screen.getByTestId("artifact-tree-type-a-1")).toHaveTextContent(
      "Markdown"
    );
    expect(screen.getAllByTestId("tree-indent-guides").length).toBeGreaterThan(
      0
    );
    expect(
      screen.queryByTestId("artifact-tree-type-folder:reports")
    ).not.toBeInTheDocument();

    fireEvent.click(within(folder).getByRole("button", { name: "Collapse" }));
    expect(
      screen.queryByTestId("artifact-tree-leaf-a-1")
    ).not.toBeInTheDocument();
    expect(
      screen.queryByTestId("artifact-inspector-panel")
    ).not.toBeInTheDocument();
    expect(folder).toHaveAttribute("aria-expanded", "false");

    fireEvent.click(within(folder).getByRole("button", { name: "Expand" }));
    fireEvent.click(screen.getByTestId("artifact-tree-leaf-a-1"));
    await waitFor(() =>
      expect(screen.getByTestId("artifact-inspector-title")).toHaveTextContent(
        "reports/summary.md"
      )
    );
    expect(screen.getByTestId("markdown-content")).toHaveTextContent(
      "reports/summary.md"
    );
  });

  it("renders a 60-item project artifact list", () => {
    const artifacts = Array.from({ length: 60 }, (_, index) =>
      artifact(`a-${index + 1}`, `artifact-${index + 1}`)
    );
    useProjectArtifacts.mockReturnValue({
      artifacts,
      isLoading: false,
      error: null,
    });

    renderPage();

    expect(screen.getAllByRole("treeitem")).toHaveLength(60);
    expect(screen.getByTestId("artifact-tree-leaf-a-60")).toBeInTheDocument();
  });

  it("navigates visible leaves in depth-first order and skips collapsed descendants", async () => {
    useProjectArtifacts.mockReturnValue({
      artifacts: [
        artifact("a-1", "docs/one.md"),
        artifact("a-2", "docs/two.md"),
        artifact("a-3", "root.md"),
      ],
      isLoading: false,
      error: null,
    });
    renderPage();

    fireEvent.click(screen.getByTestId("artifact-tree-leaf-a-1"));
    fireEvent.keyDown(screen.getByRole("tree"), { key: "ArrowDown" });
    await waitFor(() =>
      expect(screen.getByTestId("artifact-inspector-title")).toHaveTextContent(
        "docs/two.md"
      )
    );

    const folder = screen.getByTestId("artifact-tree-folder-folder:docs");
    fireEvent.click(within(folder).getByRole("button", { name: "Collapse" }));
    fireEvent.keyDown(screen.getByRole("tree"), { key: "ArrowDown" });
    await waitFor(() =>
      expect(screen.getByTestId("artifact-inspector-title")).toHaveTextContent(
        "root.md"
      )
    );
    expect(
      screen.queryByTestId("artifact-tree-leaf-a-2")
    ).not.toBeInTheDocument();
  });

  it("keeps selection keyed by artifact ID when the query refetches in a new order", async () => {
    const first = artifact("a-1", "docs/one.md");
    const second = artifact("a-2", "docs/two.md");
    const root = artifact("a-3", "root.md");
    useProjectArtifacts.mockReturnValue({
      artifacts: [first, second, root],
      isLoading: false,
      error: null,
    });
    const { rerender } = renderPage();

    fireEvent.click(screen.getByTestId("artifact-tree-leaf-a-1"));
    useProjectArtifacts.mockReturnValue({
      artifacts: [root, second, first],
      isLoading: false,
      error: null,
    });
    rerender(<ArtifactsPage />);

    await waitFor(() =>
      expect(screen.getByTestId("artifact-inspector-title")).toHaveTextContent(
        "docs/one.md"
      )
    );
    expect(screen.getByTestId("artifact-tree-leaf-a-1")).toHaveAttribute(
      "aria-selected",
      "true"
    );
  });

  describe("with a ticket open", () => {
    const taskLookup = (state: object) =>
      useTaskArtifacts.mockReturnValue({
        artifacts: [artifact("a-1", "First")],
        isLoading: false,
        error: null,
        refetch: vi.fn(),
        ...state,
      });

    it("keeps the ticket and places an attached artifact to its left", async () => {
      taskLookup({});
      useEntityPanelStore.getState().openTask("t-1");
      renderPage();
      fireEvent.click(screen.getByRole("treeitem", { name: /First/i }));
      expect(useEntityPanelStore.getState().selection).toEqual({
        type: "task",
        taskId: "t-1",
      });
      expect(
        screen.getByTestId("artifact-inspector-panel")
      ).toBeInTheDocument();
    });

    it("replaces the ticket when the artifact is unrelated", async () => {
      taskLookup({});
      useEntityPanelStore.getState().openTask("t-1");
      renderPage();
      fireEvent.click(screen.getByRole("treeitem", { name: /Second/i }));
      await waitFor(() =>
        expect(useEntityPanelStore.getState().selection).toBeNull()
      );
      await waitFor(() =>
        expect(
          screen.getByTestId("artifact-inspector-title")
        ).toHaveTextContent("Second")
      );
    });

    it("does not close the ticket while the lookup is loading or failed", async () => {
      for (const state of [{ isLoading: true }, { error: "boom" }]) {
        taskLookup(state);
        useEntityPanelStore.getState().openTask("t-1");
        const view = renderPage();
        fireEvent.click(screen.getByRole("treeitem", { name: /First/i }));
        await waitFor(() =>
          expect(
            screen.getByTestId("artifact-inspector-title")
          ).toHaveTextContent("First")
        );
        expect(useEntityPanelStore.getState().selection).not.toBeNull();
        view.unmount();
      }
    });
  });
});

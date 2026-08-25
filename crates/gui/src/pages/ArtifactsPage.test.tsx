import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, within } from "@testing-library/react";
import type { Artifact } from "../bindings";

const { useProjectArtifacts } = vi.hoisted(() => ({
  useProjectArtifacts: vi.fn(),
}));

vi.mock("../hooks/useProjectArtifacts", () => ({ useProjectArtifacts }));
vi.mock("../hooks/useShellHeader", () => ({ useShellHeader: vi.fn() }));

import { ArtifactsPage } from "./ArtifactsPage";

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
  beforeEach(() => {
    useProjectArtifacts.mockReset();
    useProjectArtifacts.mockReturnValue({
      artifacts: [artifact("a-1", "First"), artifact("a-2", "Second")],
      isLoading: false,
      error: null,
    });
  });

  it("opens and replaces the inspector from pointer or keyboard selection", () => {
    render(<ArtifactsPage />);
    fireEvent.click(screen.getByRole("treeitem", { name: /First/i }));
    expect(screen.getByTestId("artifact-inspector-title")).toHaveTextContent(
      "First"
    );

    fireEvent.keyDown(screen.getByRole("tree"), { key: "ArrowDown" });
    expect(screen.getByTestId("artifact-inspector-title")).toHaveTextContent(
      "Second"
    );
    expect(screen.getByRole("treeitem", { name: /Second/i })).toHaveAttribute(
      "aria-selected",
      "true"
    );
  });

  it("closes only the artifact inspector", () => {
    render(<ArtifactsPage />);
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
    const { rerender } = render(<ArtifactsPage />);
    expect(screen.getByLabelText("Loading artifacts")).toBeInTheDocument();

    useProjectArtifacts.mockReturnValueOnce({
      artifacts: [],
      isLoading: false,
      error: null,
    });
    rerender(<ArtifactsPage />);
    expect(screen.getByText("No project artifacts yet.")).toBeInTheDocument();

    useProjectArtifacts.mockReturnValueOnce({
      artifacts: [],
      isLoading: false,
      error: "No service",
    });
    rerender(<ArtifactsPage />);
    expect(screen.getByRole("alert")).toHaveTextContent("No service");
  });

  it("renders accessible folders and keeps folder toggles separate from selection", () => {
    useProjectArtifacts.mockReturnValue({
      artifacts: [
        artifact("a-1", "reports/summary.md"),
        artifact("a-2", "reports/detail.md"),
        artifact("a-3", "root.md"),
      ],
      isLoading: false,
      error: null,
    });
    render(<ArtifactsPage />);

    const folder = screen.getByTestId("artifact-tree-folder-folder:reports");
    expect(folder).toHaveAttribute("role", "treeitem");
    expect(folder).toHaveAttribute("aria-level", "1");
    expect(folder).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByTestId("artifact-tree-leaf-a-1")).toHaveAttribute(
      "aria-level",
      "2"
    );

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
    expect(screen.getByTestId("artifact-inspector-title")).toHaveTextContent(
      "reports/summary.md"
    );
    expect(screen.getByTestId("markdown-content")).toHaveTextContent(
      "reports/summary.md"
    );
  });

  it("navigates visible leaves in depth-first order and skips collapsed descendants", () => {
    useProjectArtifacts.mockReturnValue({
      artifacts: [
        artifact("a-1", "docs/one.md"),
        artifact("a-2", "docs/two.md"),
        artifact("a-3", "root.md"),
      ],
      isLoading: false,
      error: null,
    });
    render(<ArtifactsPage />);

    fireEvent.click(screen.getByTestId("artifact-tree-leaf-a-1"));
    fireEvent.keyDown(screen.getByRole("tree"), { key: "ArrowDown" });
    expect(screen.getByTestId("artifact-inspector-title")).toHaveTextContent(
      "docs/two.md"
    );

    const folder = screen.getByTestId("artifact-tree-folder-folder:docs");
    fireEvent.click(within(folder).getByRole("button", { name: "Collapse" }));
    fireEvent.keyDown(screen.getByRole("tree"), { key: "ArrowDown" });
    expect(screen.getByTestId("artifact-inspector-title")).toHaveTextContent(
      "root.md"
    );
    expect(
      screen.queryByTestId("artifact-tree-leaf-a-2")
    ).not.toBeInTheDocument();
  });

  it("keeps selection keyed by artifact ID when the query refetches in a new order", () => {
    const first = artifact("a-1", "docs/one.md");
    const second = artifact("a-2", "docs/two.md");
    const root = artifact("a-3", "root.md");
    useProjectArtifacts.mockReturnValue({
      artifacts: [first, second, root],
      isLoading: false,
      error: null,
    });
    const { rerender } = render(<ArtifactsPage />);

    fireEvent.click(screen.getByTestId("artifact-tree-leaf-a-1"));
    useProjectArtifacts.mockReturnValue({
      artifacts: [root, second, first],
      isLoading: false,
      error: null,
    });
    rerender(<ArtifactsPage />);

    expect(screen.getByTestId("artifact-inspector-title")).toHaveTextContent(
      "docs/one.md"
    );
    expect(screen.getByTestId("artifact-tree-leaf-a-1")).toHaveAttribute(
      "aria-selected",
      "true"
    );
  });
});

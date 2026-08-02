import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
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
    useProjectArtifacts.mockReturnValue({
      artifacts: [artifact("a-1", "First"), artifact("a-2", "Second")],
      isLoading: false,
      error: null,
    });
  });

  it("opens and replaces the inspector from pointer or keyboard selection", () => {
    render(<ArtifactsPage />);
    fireEvent.click(screen.getByRole("option", { name: /First/i }));
    expect(screen.getByTestId("artifact-inspector-title")).toHaveTextContent(
      "First"
    );

    fireEvent.keyDown(screen.getByRole("listbox"), { key: "ArrowDown" });
    expect(screen.getByTestId("artifact-inspector-title")).toHaveTextContent(
      "Second"
    );
    expect(screen.getByRole("option", { name: /Second/i })).toHaveAttribute(
      "aria-selected",
      "true"
    );
  });

  it("closes only the artifact inspector", () => {
    render(<ArtifactsPage />);
    fireEvent.click(screen.getByRole("option", { name: /First/i }));
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
});

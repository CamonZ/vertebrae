import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { Artifact } from "../../bindings";
import { ArtifactInspectorPanel } from "./ArtifactInspectorPanel";

const artifact: Artifact = {
  id: "artifact-1",
  project_id: "project-1",
  filename: "notes.md",
  body: "# Notes",
  logical_name: "notes",
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
};

describe("ArtifactInspectorPanel", () => {
  it("keeps its content shell transparent so the shared glass panel is visible", () => {
    render(
      <ArtifactInspectorPanel
        artifact={artifact}
        onClose={vi.fn()}
        onExitAnimationEnd={vi.fn()}
      />
    );

    expect(screen.getByTestId("artifact-inspector-panel")).toHaveClass(
      "detail-float"
    );
    expect(screen.getByTestId("artifact-inspector-content")).not.toHaveClass(
      "bg-bg"
    );
  });
});

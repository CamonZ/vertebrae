import { describe, expect, it, vi, beforeEach } from "vitest";
import { MemoryRouter, useNavigate } from "react-router-dom";
import { act, render, screen } from "@testing-library/react";
import { GlobalEntityPanelHost } from "./GlobalEntityPanelHost";
import { useEntityPanelStore } from "../stores/entityPanelStore";

vi.mock("./TaskDetail", () => ({
  TaskDetailPanel: ({ taskId }: { taskId: string }) => (
    <div data-testid="task-detail-stub">{taskId}</div>
  ),
}));
vi.mock("./Artifacts/ArtifactPanelHost", () => ({
  ArtifactPanelHost: () => null,
}));
vi.mock("../hooks/usePipelineSummary", () => ({
  usePipelineSummary: () => ({ summary: null, isLoading: false, error: null }),
}));

let navigate: ReturnType<typeof useNavigate>;
function Probe() {
  navigate = useNavigate();
  return null;
}

describe("GlobalEntityPanelHost page switching", () => {
  beforeEach(() => {
    useEntityPanelStore.getState().reset();
  });

  it("closes the task detail panel when the page changes", () => {
    render(
      <MemoryRouter initialEntries={["/tasks"]}>
        <Probe />
        <GlobalEntityPanelHost />
      </MemoryRouter>
    );

    act(() => useEntityPanelStore.getState().openTask("task-1"));
    expect(screen.getByTestId("task-detail-stub")).toHaveTextContent("task-1");

    act(() => navigate("/artifacts"));
    expect(useEntityPanelStore.getState().selection).toBeNull();
  });

  it("keeps the panel open while the page stays the same", () => {
    render(
      <MemoryRouter initialEntries={["/tasks"]}>
        <Probe />
        <GlobalEntityPanelHost />
      </MemoryRouter>
    );

    act(() => useEntityPanelStore.getState().openTask("task-1"));
    act(() => useEntityPanelStore.getState().openTask("task-2"));
    expect(useEntityPanelStore.getState().selection).toEqual({
      type: "task",
      taskId: "task-2",
    });
  });
});

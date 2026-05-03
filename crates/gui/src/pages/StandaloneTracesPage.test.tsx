import { describe, it, expect, vi, beforeEach } from "vitest";
import { fireEvent, screen, render as rtlRender } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { StandaloneTracesPage } from "./StandaloneTracesPage";

// Stub WindowLayout so we don't pull in GlobalListeners + ToastContainer
// and their backend wiring in this focused test.
vi.mock("../components/WindowLayout", () => ({
  WindowLayout: ({ children }: { children: React.ReactNode }) => (
    <div data-testid="window-layout">{children}</div>
  ),
}));

// Capture the props TracesPage receives so we can assert the route taskId
// is forwarded as `taskIdOverride`, the standalone flag is set, and
// inter-task picker selection updates local state in place.
const lastProps: {
  taskIdOverride?: string | null;
  standalone?: boolean;
}[] = [];
vi.mock("./TracesPage", () => ({
  TracesPage: ({
    taskIdOverride,
    onPickTask,
    standalone,
  }: {
    taskIdOverride?: string | null;
    onPickTask?: (id: string) => void;
    standalone?: boolean;
  }) => {
    lastProps.push({ taskIdOverride, standalone });
    return (
      <div data-testid="traces-page">
        <span data-testid="active-task-id">{taskIdOverride ?? ""}</span>
        <span data-testid="standalone-flag">{String(Boolean(standalone))}</span>
        <button
          data-testid="pick-other"
          onClick={() => onPickTask?.("other-task-999")}
        >
          pick other
        </button>
      </div>
    );
  },
}));

function renderAt(path: string) {
  return rtlRender(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route
          path="/traces-window/:taskId"
          element={<StandaloneTracesPage />}
        />
      </Routes>
    </MemoryRouter>,
  );
}

describe("StandaloneTracesPage", () => {
  beforeEach(() => {
    lastProps.length = 0;
  });

  it("renders TracesPage in standalone mode inside WindowLayout, seeded from the route taskId", () => {
    renderAt("/traces-window/abc-123");

    expect(screen.getByTestId("window-layout")).toBeInTheDocument();
    expect(screen.getByTestId("active-task-id")).toHaveTextContent("abc-123");
    expect(screen.getByTestId("standalone-flag")).toHaveTextContent("true");
    expect(lastProps[0]).toEqual({
      taskIdOverride: "abc-123",
      standalone: true,
    });
  });

  it("swaps active task in-place when the picker fires onPickTask (window URL/label stays stable)", () => {
    renderAt("/traces-window/abc-123");

    expect(screen.getByTestId("active-task-id")).toHaveTextContent("abc-123");

    fireEvent.click(screen.getByTestId("pick-other"));

    expect(screen.getByTestId("active-task-id")).toHaveTextContent(
      "other-task-999",
    );
    // Last render received the updated override but kept standalone true.
    const last = lastProps[lastProps.length - 1];
    expect(last).toEqual({
      taskIdOverride: "other-task-999",
      standalone: true,
    });
  });
});

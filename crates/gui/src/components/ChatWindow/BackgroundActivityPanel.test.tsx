import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { BackgroundActivityPanel } from "./BackgroundActivityPanel";
import { formatElapsed } from "./backgroundActivity";
import {
  applyBackgroundUpdate,
  EMPTY_BACKGROUND_WORK,
  markBackgroundWorkStale,
  type BackgroundWorkState,
  type BackgroundWorkUpdate,
} from "../../stores/backgroundWork";

vi.mock("../../bindings", () => ({ commands: {}, events: {} }));

function update(
  overrides: Partial<BackgroundWorkUpdate>
): BackgroundWorkUpdate {
  return {
    eventId: overrides.eventId ?? `${overrides.workId}-${overrides.status}`,
    workId: "w",
    generation: 0,
    kind: "command",
    providerKind: null,
    status: "running",
    description: null,
    progress: null,
    launchToolId: null,
    startedAt: null,
    finishedAt: null,
    error: null,
    observedAt: "2026-11-13T12:00:00Z",
    turnId: null,
    threadId: null,
    ...overrides,
  };
}

function state(
  ...updates: Partial<BackgroundWorkUpdate>[]
): BackgroundWorkState {
  return updates.reduce(
    (current, next) =>
      applyBackgroundUpdate(current, update(next), { live: true }).state,
    EMPTY_BACKGROUND_WORK
  );
}

describe("BackgroundActivityPanel", () => {
  afterEach(() => vi.useRealTimers());

  it("says nothing is running once every task has settled", () => {
    render(
      <BackgroundActivityPanel
        work={state(
          { workId: "a", description: "dev server" },
          { workId: "a", status: "completed" }
        )}
      />
    );

    expect(screen.queryAllByTestId("background-activity-row")).toHaveLength(0);
    expect(
      screen.getByText("No background tasks are running.")
    ).toBeInTheDocument();
  });

  it("shows a command's progress and an elapsed time that ticks with the clock", () => {
    vi.useFakeTimers();
    let now = Date.parse("2026-11-13T12:01:05Z");

    render(
      <BackgroundActivityPanel
        now={() => now}
        work={state({
          workId: "dev",
          description: "npm run dev",
          progress: "listening on :5173",
          startedAt: "2026-11-13T12:00:00Z",
        })}
      />
    );

    expect(screen.getByText("1 background task running")).toBeInTheDocument();
    expect(screen.getByText("npm run dev")).toBeInTheDocument();
    expect(
      screen.getByTestId("background-activity-progress")
    ).toHaveTextContent("listening on :5173");
    expect(screen.getByTestId("background-activity-elapsed")).toHaveTextContent(
      "1m 05s"
    );

    now += 2_000;
    act(() => vi.advanceTimersByTime(1_000));

    expect(screen.getByTestId("background-activity-elapsed")).toHaveTextContent(
      "1m 07s"
    );
  });

  it("never fabricates elapsed time or progress when the provider sent none", () => {
    render(
      <BackgroundActivityPanel
        work={state({ workId: "w", description: "Audit" })}
      />
    );

    expect(screen.getByText("Audit")).toBeInTheDocument();
    expect(screen.queryByTestId("background-activity-elapsed")).toBeNull();
    expect(screen.queryByTestId("background-activity-progress")).toBeNull();
    expect(screen.queryByText(/%/)).toBeNull();
  });

  it("counts only confirmed rows and labels unconfirmed ones", () => {
    let work = state(
      { workId: "a", kind: "command", description: "server" },
      { workId: "b", kind: "other", description: "index" }
    );
    work = markBackgroundWorkStale(work);
    work = applyBackgroundUpdate(
      work,
      update({
        workId: "c",
        kind: "command",
        description: "tests",
        eventId: "c",
      }),
      { live: true }
    ).state;

    render(<BackgroundActivityPanel work={work} />);

    const panel = screen.getByTestId("background-activity");
    const rows = screen.getAllByTestId("background-activity-row");

    expect(panel.dataset.activeCount).toBe("1");
    expect(
      screen.getByText("1 background task running · 2 unconfirmed")
    ).toBeInTheDocument();
    expect(rows.map((row) => row.dataset.fresh)).toEqual([
      "false",
      "false",
      "true",
    ]);
    expect(screen.getAllByText(/Not confirmed running/)).toHaveLength(2);
  });

  it("closes from its own header", () => {
    const onClose = vi.fn();
    render(
      <BackgroundActivityPanel
        work={state({ workId: "w" })}
        onClose={onClose}
      />
    );

    fireEvent.click(
      screen.getByRole("button", { name: "Close Background tasks panel" })
    );

    expect(onClose).toHaveBeenCalledTimes(1);
  });
});

describe("formatElapsed", () => {
  it.each([
    [0, "0s"],
    [12_400, "12s"],
    [185_000, "3m 05s"],
    [3_720_000, "1h 02m"],
    [-5_000, "0s"],
  ])("%d ms → %s", (ms, text) => expect(formatElapsed(ms)).toBe(text));
});

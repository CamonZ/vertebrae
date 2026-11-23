import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { BackgroundActivityPanel } from "./BackgroundActivityPanel";
import { formatElapsed } from "./backgroundActivity";
import { BACKGROUND_LIST_KEYS, keyHintText } from "./chatShortcuts";
import { focusedPaletteScopes } from "../CommandPalette/paletteScopes";
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

describe("BackgroundActivityPanel list keys", () => {
  it("walks one list with ↑/↓, shows output with ↵ and copies the command with ⌘C", () => {
    const writeText = vi.fn<(text: string) => Promise<void>>(async () => {});
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText },
    });
    render(
      <BackgroundActivityPanel
        work={state(
          {
            workId: "dev",
            description: "npm run dev",
            progress: "ready on :1420",
          },
          { workId: "lint", description: "npm run lint", progress: "checking" }
        )}
      />
    );
    const section = screen.getByRole("region", { name: "Background tasks" });
    const [first, second] = screen.getAllByTestId("background-activity-row");

    act(() => section.focus());
    fireEvent.keyDown(section, { key: "ArrowDown" });
    expect(first).toHaveFocus();
    fireEvent.keyDown(first, { key: "ArrowDown" });
    expect(second).toHaveFocus();
    fireEvent.keyDown(second, { key: "ArrowDown" });
    expect(second).toHaveFocus();
    fireEvent.keyDown(second, { key: "ArrowUp" });
    expect(first).toHaveFocus();

    expect(first).toHaveAttribute("aria-expanded", "false");
    fireEvent.keyDown(first, { key: "Enter" });
    expect(first).toHaveAttribute("aria-expanded", "true");
    fireEvent.keyDown(first, { key: "Enter" });
    expect(first).toHaveAttribute("aria-expanded", "false");

    fireEvent.keyDown(first, { key: "c", code: "KeyC", metaKey: true });
    expect(writeText).toHaveBeenCalledOnce();
    expect(first).toHaveTextContent(writeText.mock.calls[0][0]);
  });

  it("offers the focused task's keys in the palette's Background tasks scope", () => {
    const writeText = vi.fn<(text: string) => Promise<void>>(async () => {});
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText },
    });
    render(
      <BackgroundActivityPanel
        work={state(
          {
            workId: "dev",
            description: "npm run dev",
            progress: "ready on :1420",
          },
          { workId: "quiet", description: "npm run build" }
        )}
      />
    );
    const [dev, quiet] = screen.getAllByTestId("background-activity-row");

    act(() => dev.focus());
    const { contexts, initial } = focusedPaletteScopes();
    expect(initial).toBe("background");
    const move = { key: keyHintText(BACKGROUND_LIST_KEYS.move) };
    expect(
      contexts[0].items.map((item) => [item.label, item.access, item.hint])
    ).toEqual([
      ["Next task", move, "npm run dev"],
      ["Previous task", move, "npm run dev"],
      [BACKGROUND_LIST_KEYS.output.label, { key: "↵" }, "npm run dev"],
      [
        BACKGROUND_LIST_KEYS.copy.label,
        { key: keyHintText(BACKGROUND_LIST_KEYS.copy) },
        "npm run dev",
      ],
    ]);
    const run = (label: string) =>
      act(() => contexts[0].items.find((item) => item.label === label)!.run());
    run(BACKGROUND_LIST_KEYS.output.label);
    expect(dev).toHaveAttribute("aria-expanded", "true");
    run(BACKGROUND_LIST_KEYS.copy.label);
    expect(writeText).toHaveBeenCalledExactlyOnceWith("npm run dev");
    run("Next task");
    expect(quiet).toHaveFocus();

    // No output to show on this one; there is no "Stop task" (no backend action).
    const labels = focusedPaletteScopes().contexts[0].items.map(
      (item) => item.label
    );
    expect(labels).not.toContain(BACKGROUND_LIST_KEYS.output.label);
    expect(labels.join(" ")).not.toMatch(/stop/i);
  });

  it("offers only what a row has: no output to show, no command to copy", () => {
    const writeText = vi.fn<(text: string) => Promise<void>>(async () => {});
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText },
    });
    render(
      <BackgroundActivityPanel
        work={state(
          { workId: "quiet", description: "npm run build" },
          { workId: "internal-id", progress: "working" }
        )}
      />
    );
    const [quiet, unnamed] = screen.getAllByRole("button", {
      name: /npm run build|internal-id/,
    });

    expect(quiet.tagName).toBe("BUTTON");
    expect(quiet).not.toHaveAttribute("aria-expanded");
    expect(quiet).toHaveAttribute("aria-keyshortcuts", "Meta+C");
    expect(quiet.title).not.toContain("output");
    fireEvent.keyDown(quiet, { key: "Enter" });
    expect(quiet).not.toHaveAttribute("aria-expanded");

    expect(unnamed).toHaveAttribute("aria-keyshortcuts", "Enter");
    fireEvent.keyDown(unnamed, { key: "c", code: "KeyC", metaKey: true });
    expect(writeText).not.toHaveBeenCalled();
  });
});

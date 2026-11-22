import { act, cleanup, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RefObject } from "react";
import {
  COMMENTED_LINE_ATTRIBUTE,
  useCommentedLines,
  type CommentedRange,
} from "./commentedLines";

/*
 * A stand-in for one rendered Pierre diff: a shadow root with a unified code
 * column whose rows carry `data-line-index`, and an instance mapping new-side
 * line N to index N - 1.
 */
function renderedDiff(id: string, lines: number) {
  const element = document.createElement("div");
  const root = element.attachShadow({ mode: "open" });
  const column = document.createElement("div");
  column.setAttribute("data-code", "");
  column.setAttribute("data-unified", "");
  for (let index = 0; index < lines; index++) {
    for (const kind of ["data-column-number", "data-line"]) {
      const row = document.createElement("div");
      row.setAttribute(kind, "");
      row.setAttribute("data-line-index", `${index},${index}`);
      column.append(row);
    }
  }
  root.append(column);
  return {
    id,
    type: "diff" as const,
    element,
    instance: {
      getLineIndex: (line: number, side: string) =>
        side === "additions" && line >= 1 && line <= lines
          ? [line - 1, line - 1]
          : undefined,
    },
  };
}

function viewWith(items: ReturnType<typeof renderedDiff>[]) {
  return {
    current: { getInstance: () => ({ getRenderedItems: () => items }) },
  } as unknown as RefObject<never>;
}

function Marks({
  view,
  ranges,
  onSchedule,
}: {
  view: RefObject<never>;
  ranges: (id: string) => readonly CommentedRange[];
  onSchedule?: (schedule: () => void) => void;
}) {
  const schedule = useCommentedLines(view, ranges);
  onSchedule?.(schedule);
  return null;
}

/** Each row's mark, by line index: "" plain, "-" commented, "A" active. */
function marks(item: ReturnType<typeof renderedDiff>) {
  return [...item.element.shadowRoot!.querySelectorAll("[data-line]")].map(
    (row) => {
      const mark = row.getAttribute(COMMENTED_LINE_ATTRIBUTE);
      const number = row.previousElementSibling!.getAttribute(
        COMMENTED_LINE_ATTRIBUTE
      );
      expect(number).toBe(mark);
      return mark === null ? "" : mark === "active" ? "A" : "-";
    }
  );
}

const range = (
  start: number,
  end: number,
  active = false,
  side: CommentedRange["side"] = "additions"
): CommentedRange => ({ side, start, end, active });

beforeEach(() => {
  vi.useFakeTimers({
    toFake: ["requestAnimationFrame", "cancelAnimationFrame"],
  });
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("useCommentedLines", () => {
  it("marks every row of each commented range, the active one strongest", () => {
    const item = renderedDiff("a", 8);
    const ranges = [range(2, 3), range(5, 6, true), range(6, 7)];
    render(<Marks view={viewWith([item])} ranges={() => ranges} />);
    act(() => vi.runOnlyPendingTimers());
    expect(marks(item)).toEqual(["", "-", "-", "", "A", "A", "-", ""]);
  });

  it("follows range changes and clears on unmount", () => {
    const item = renderedDiff("a", 4);
    const view = viewWith([item]);
    const first = () => [range(1, 2)];
    const { rerender, unmount } = render(<Marks view={view} ranges={first} />);
    act(() => vi.runOnlyPendingTimers());
    expect(marks(item)).toEqual(["-", "-", "", ""]);

    const second = () => [range(4, 4, true)];
    rerender(<Marks view={view} ranges={second} />);
    act(() => vi.runOnlyPendingTimers());
    expect(marks(item)).toEqual(["", "", "", "A"]);

    unmount();
    expect(marks(item)).toEqual(["", "", "", ""]);
  });

  it("marks each file from its own ranges and skips lines not rendered", () => {
    const a = renderedDiff("a", 3);
    const b = renderedDiff("b", 3);
    const ranges = (id: string) =>
      id === "a" ? [range(3, 9)] : [range(1, 1, false, "deletions")];
    render(<Marks view={viewWith([a, b])} ranges={ranges} />);
    act(() => vi.runOnlyPendingTimers());
    expect(marks(a)).toEqual(["", "", "-"]);
    expect(marks(b)).toEqual(["", "", ""]);
  });

  it("re-marks rows Pierre re-rendered when scheduled after a render", () => {
    const item = renderedDiff("a", 2);
    const view = viewWith([item]);
    let schedule = () => {};
    const ranges = [range(1, 2)];
    render(
      <Marks
        view={view}
        ranges={() => ranges}
        onSchedule={(next) => (schedule = next)}
      />
    );
    act(() => vi.runOnlyPendingTimers());
    // Pierre replaced the rows (virtualization or a re-render).
    const fresh = renderedDiff("a", 2);
    item.element.shadowRoot!.replaceChildren(
      ...fresh.element.shadowRoot!.childNodes
    );
    expect(marks(item)).toEqual(["", ""]);
    act(() => {
      schedule();
      vi.runOnlyPendingTimers();
    });
    expect(marks(item)).toEqual(["-", "-"]);
  });
});

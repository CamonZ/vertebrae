import { act, fireEvent, render } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { useInlineScrollFollow } from "./useInlineScrollFollow";

function Discussion({ inDiff, turnId }: { inDiff: boolean; turnId?: string }) {
  const ref = useInlineScrollFollow(turnId);
  return (
    <div>
      <div
        className={inDiff ? "changes-code-view" : undefined}
        data-transcript-viewport={inDiff ? undefined : ""}
        data-testid="viewport"
      >
        <section ref={ref} data-testid="discussion" />
      </div>
    </div>
  );
}

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

it.each([
  { surface: "Changes", inDiff: true },
  { surface: "the chat transcript", inDiff: false },
])(
  "follows the inline card in $surface and respects user scroll",
  ({ inDiff }) => {
    vi.useFakeTimers();
    let notifyResize = () => {};
    vi.stubGlobal(
      "ResizeObserver",
      class {
        constructor(callback: () => void) {
          notifyResize = callback;
        }
        observe() {}
        disconnect() {}
      }
    );

    const { getByTestId, rerender } = render(<Discussion inDiff={inDiff} />);
    const viewport = getByTestId("viewport");
    const card = getByTestId("discussion");
    Object.defineProperties(viewport, {
      clientHeight: { value: 300 },
      scrollHeight: { value: 2000 },
    });
    let cardBottom = 600;
    vi.spyOn(card, "getBoundingClientRect").mockImplementation(
      () => new DOMRect(0, 0, 500, cardBottom - viewport.scrollTop)
    );

    const tick = () => act(() => vi.advanceTimersByTime(32));
    const grow = () => {
      cardBottom += 100;
      notifyResize();
      tick();
    };
    const scrollUp = () => {
      fireEvent.wheel(viewport, { deltaY: -100 });
      viewport.scrollTop -= 100;
      fireEvent.scroll(viewport);
    };

    rerender(<Discussion inDiff={inDiff} turnId="second" />);
    tick();
    expect(viewport.scrollTop).toBe(300);
    grow();
    expect(viewport.scrollTop).toBe(400);

    scrollUp();
    grow();
    expect(viewport.scrollTop).toBe(300);

    viewport.scrollTop = 500;
    fireEvent.scroll(viewport);
    grow();
    expect(viewport.scrollTop).toBe(600);

    scrollUp();
    rerender(<Discussion inDiff={inDiff} />);
    grow();
    expect(viewport.scrollTop).toBe(500);

    rerender(<Discussion inDiff={inDiff} turnId="third" />);
    tick();
    expect(viewport.scrollTop).toBe(700);
  }
);

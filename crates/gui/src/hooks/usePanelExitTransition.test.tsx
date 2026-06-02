import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { usePanelExitTransition } from "./usePanelExitTransition";

const render = (open: boolean) =>
  renderHook(({ o }) => usePanelExitTransition(o, 180), {
    initialProps: { o: open },
  });

/** A fake animationend on the panel root (target === currentTarget). */
const fakeAnimEnd = () => {
  const node = {} as EventTarget;
  return { target: node, currentTarget: node };
};

describe("usePanelExitTransition", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("is mounted and not closing while open", () => {
    const { result } = render(true);
    expect(result.current.mounted).toBe(true);
    expect(result.current.closing).toBe(false);
  });

  it("starts unmounted when initially closed (and schedules no timer)", () => {
    const { result } = render(false);
    expect(result.current.mounted).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("stays mounted+closing until the exit animation ends, then unmounts", () => {
    const { result, rerender } = render(true);

    act(() => rerender({ o: false }));
    expect(result.current.mounted).toBe(true);
    expect(result.current.closing).toBe(true);

    // The fixed timer alone must NOT pull it before the animation ends.
    act(() => vi.advanceTimersByTime(180));
    expect(result.current.mounted).toBe(true);

    // animationend on the panel root unmounts it.
    act(() => result.current.onAnimationEnd(fakeAnimEnd()));
    expect(result.current.mounted).toBe(false);
    expect(result.current.closing).toBe(false);
  });

  it("falls back to a timer if animationend never fires (reduced motion)", () => {
    const { result, rerender } = render(true);

    act(() => rerender({ o: false }));
    expect(result.current.mounted).toBe(true);

    // No animationend; the safety-net timer (duration + margin) unmounts it.
    act(() => vi.advanceTimersByTime(180 + 80));
    expect(result.current.mounted).toBe(false);
  });

  it("ignores a child's animationend (target !== currentTarget)", () => {
    const { result, rerender } = render(true);
    act(() => rerender({ o: false }));

    act(() =>
      result.current.onAnimationEnd({
        target: {} as EventTarget,
        currentTarget: {} as EventTarget,
      })
    );
    expect(result.current.mounted).toBe(true);
  });

  it("re-opening mid-close cancels the pending unmount", () => {
    const { result, rerender } = render(true);

    act(() => rerender({ o: false }));
    expect(result.current.closing).toBe(true);

    act(() => {
      vi.advanceTimersByTime(90);
      rerender({ o: true });
    });
    expect(result.current.mounted).toBe(true);
    expect(result.current.closing).toBe(false);

    // The original fallback timer must not fire after re-open.
    act(() => vi.advanceTimersByTime(400));
    expect(result.current.mounted).toBe(true);
    expect(result.current.closing).toBe(false);
  });
});

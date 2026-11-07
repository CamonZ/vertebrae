import { act, fireEvent, render } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import * as hegel from "@hegeldev/hegel";
import * as gs from "@hegeldev/hegel/generators";
import { ChatMessages } from "./ChatMessages";
import type { ChatMessage } from "../../stores/chatStore";

// Browser geometry is independent of jsdom layout. Writes clamp immediately;
// scroll and ResizeObserver deliveries are separately delayed/coalesced.
function browser(height = 1200, viewport = 100) {
  vi.useFakeTimers();

  let hidden = false;
  vi.spyOn(document, "hidden", "get").mockImplementation(() => hidden);
  const observers: { deliver: () => void; targets: Element[] }[] = [];

  class ScheduledResizeObserver {
    targets: Element[] = [];

    constructor(callback: () => void) {
      const observer = { deliver: callback, targets: this.targets };
      observers.push(observer);
    }

    observe(target: Element) {
      this.targets.push(target);
    }

    disconnect() {}
  }

  vi.stubGlobal("ResizeObserver", ScheduledResizeObserver);

  let messages: ChatMessage[] = [];
  let sessionId = "scroll-session";
  let visible = true;
  let load: (() => Promise<boolean>) | undefined;

  const props = () => ({
    sessionId,
    messages,
    assistantLabel: "Agent",
    isEmpty: false,
    isActive: true,
    isWaiting: true,
    streamingAssistant: null,
    isVisible: visible,
    hasOlderMessages: true,
    onLoadOlderMessages: load,
  });
  const initialProps = props();
  const view = render(<ChatMessages {...initialProps} />);
  const container = view.getByTestId("chat-messages-scroll");

  let top = 0;
  let queuedScroll = false;
  let queuedResize = false;
  let writes = 0;

  const max = () => Math.max(0, height - viewport);
  const clamp = (value: number) => {
    const maximum = max();
    const boundedValue = Math.min(value, maximum);

    return Math.max(0, boundedValue);
  };

  Object.defineProperties(container, {
    clientHeight: { configurable: true, get: () => viewport },
    scrollHeight: { configurable: true, get: () => height },
    scrollTop: {
      configurable: true,
      get: () => top,
      set: (value: number) => {
        writes++;

        const next = clamp(value);
        if (top !== next) queuedScroll = true;
        top = next;
      },
    },
  });

  const scroll = () => {
    if (queuedScroll) {
      queuedScroll = false;
      fireEvent.scroll(container);
    }
  };

  const resize = () => {
    if (queuedResize) {
      queuedResize = false;
      const observer = observers.at(-1);

      act(() => observer?.deliver());
    }
  };

  const tick = () => act(() => vi.advanceTimersByTime(32));

  const rerender = () => {
    const currentProps = props();
    view.rerender(<ChatMessages {...currentProps} />);
  };

  const deliverRetiredObservers = () => {
    act(() => {
      for (const observer of observers) observer.deliver();
    });
  };

  return {
    container,
    observers,
    max,
    get height() {
      return height;
    },
    get top() {
      return top;
    },
    get writes() {
      return writes;
    },
    tick,
    scroll,
    resize,
    deliverRetiredObservers,
    settle() {
      resize();
      tick();
      scroll();

      tick();
      scroll();
    },
    geometry(nextHeight: number, nextViewport = viewport) {
      height = nextHeight;
      viewport = nextViewport;

      const next = clamp(top);
      if (next !== top) queuedScroll = true;
      top = next;
      queuedResize = true;
    },
    user(
      value: number,
      input: "wheel" | "touch" | "keyboard" | "scrollbar" = "wheel"
    ) {
      if (value < top) {
        if (input === "wheel") fireEvent.wheel(container, { deltaY: -1 });
        if (input === "touch") fireEvent.touchStart(container);
        if (input === "keyboard")
          fireEvent.keyDown(container, { key: "PageUp" });
        if (input === "scrollbar") fireEvent.pointerDown(container);
      }

      top = clamp(value);
      queuedScroll = true;
      scroll();

      fireEvent.touchEnd(container);
      fireEvent.pointerUp(container);
    },
    elastic(value: number) {
      top = value;
      queuedScroll = true;
      scroll();
    },
    update() {
      messages = [
        ...messages,
        { kind: "user", text: "text", timestamp: "now" },
      ];

      rerender();
    },
    hidden(value: boolean) {
      hidden = value;
      const event = new Event("visibilitychange");

      fireEvent(document, event);
    },
    visibility(value: boolean) {
      visible = value;

      rerender();
    },
    switchSession() {
      sessionId += "-next";
      messages = [];

      rerender();
    },
    async prepend(delta: number) {
      let resolve!: (applied: boolean) => void;
      load = () =>
        new Promise<boolean>((done) => {
          resolve = done;
        });

      rerender();
      const loadButton = view.getByRole("button", {
        name: "Load older messages",
      });
      fireEvent.click(loadButton);

      height += delta;
      messages = [
        { kind: "user", text: "older", timestamp: "before" },
        ...messages,
      ];

      rerender();

      await act(async () => resolve(true));
      scroll();
    },
    unmount: view.unmount,
  };
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

it.each(["messages", "resize"])(
  "follows growth before a queued programmatic scroll event (%s)",
  (source) => {
    const b = browser();
    b.settle();

    b.user(500);
    b.user(1080);
    b.tick();

    b.geometry(1400);
    if (source === "messages") b.update();
    else b.resize();
    fireEvent.scroll(b.container);
    b.settle();

    expect(b.top).toBe(1300);

    b.unmount();
  }
);

it("cancels pending follow on upward scrolling and resumes without another provider event", () => {
  const b = browser();
  b.settle();

  b.geometry(1400);
  b.resize();
  b.user(700);
  b.tick();

  expect(b.top).toBe(700);

  b.user(1280);
  b.tick();

  expect(b.top).toBe(1300);

  b.unmount();
});

it("follows bottom elastic rebound, shrink, and viewport-only reflow", () => {
  const b = browser();
  b.settle();

  b.elastic(1180);
  b.elastic(1100);

  b.geometry(800);
  b.scroll();
  b.settle();

  b.geometry(1500, 250);
  b.settle();

  expect(b.top).toBe(1250);
  expect(b.observers[0].targets).toContain(b.container);

  b.unmount();
});

it.each(["touch", "scrollbar"])(
  "keeps %s intent across small movements inside the tolerance",
  (input) => {
    const b = browser();
    b.settle();

    if (input === "touch") fireEvent.touchStart(b.container);
    else fireEvent.pointerDown(b.container);

    b.container.scrollTop = 1090;
    b.scroll();
    b.tick();

    b.container.scrollTop = 1050;
    b.scroll();
    fireEvent.touchEnd(b.container);
    fireEvent.pointerUp(b.container);
    b.geometry(1400);
    b.settle();

    expect(b.top).toBe(1050);

    b.unmount();
  }
);

it.each(["touch", "scrollbar"])(
  "preserves a reading position when the final %s scroll arrives after release",
  (input) => {
    const b = browser();
    b.settle();

    if (input === "touch") fireEvent.touchStart(b.container);
    else fireEvent.pointerDown(b.container);

    b.container.scrollTop = 500; // Queue the user scroll until after release.
    fireEvent.touchEnd(b.container);
    fireEvent.pointerUp(b.container);
    b.scroll();
    b.geometry(1400);
    b.settle();

    expect(b.top).toBe(500);

    b.unmount();
  }
);

// Minimized Hegel counterexamples, retained as named regressions.
it("follows after a near-bottom touch, viewport clamping and delayed scroll delivery", () => {
  const b = browser(0, 100);
  b.settle();

  b.geometry(101);
  b.update();
  b.tick();
  b.user(b.max() - 0.5, "touch");
  expect(b.top).toBe(0.5);

  b.geometry(101, 101); // Clamp to zero without delivering the scroll event.
  expect(b.top).toBe(0);
  b.geometry(126, 101);
  b.update();
  b.scroll(); // Deliver the clamped scroll after growth moved the bottom to 25.

  b.hidden(false);
  b.visibility(true);
  b.settle();

  expect(b.max()).toBe(25);
  expect(b.top).toBe(25);

  b.unmount();
});

it("ignores coalesced viewport clamping followed by streamed growth", () => {
  const b = browser();
  b.settle();

  b.geometry(1200, 101); // Clamp 1100 to 1099, queue its scroll event.
  b.geometry(1225, 101);
  b.update(); // Bottom now 1124 before delivery.
  b.scroll();
  b.settle();

  expect(b.top).toBe(1124);

  b.unmount();
});

it("does not resume a paused reader after prepend compensation near the bottom", async () => {
  const b = browser(0);
  b.settle();

  b.geometry(101);
  b.update();
  await b.prepend(1);
  b.resize();
  b.tick();
  b.scroll();

  expect(b.top).toBe(1);

  b.unmount();
});

it("retires observers and timers on session change and unmount", () => {
  const b = browser();
  b.settle();

  b.geometry(1400);
  b.resize();

  const old = b.observers[0];
  b.switchSession();
  b.settle();
  b.user(500);

  const writes = b.writes;
  act(() => old.deliver());
  b.tick();
  expect(b.writes).toBe(writes);

  const bottom = b.max();
  b.user(bottom);
  b.unmount();

  const finalWrites = b.writes;
  b.deliverRetiredObservers();
  b.tick();
  expect(b.writes).toBe(finalWrites);
});

it(
  "generated schedules preserve following, reading positions, prepends and lifecycle isolation",
  () =>
    hegel.testAsync(
      async (tc) => {
        const initialHeightGenerator = gs.sampledFrom([0, 80, 100, 1200, 4000]);
        const inputGenerator = gs.sampledFrom([
          "wheel",
          "touch",
          "keyboard",
          "scrollbar",
        ] as const);
        const kindGenerator = gs.sampledFrom([
          "text",
          "panel",
          "viewport",
          "shrink",
          "scroll",
          "resize",
          "timer",
          "user",
          "elastic",
          "hidden",
          "visible",
          "session",
          "prepend",
        ] as const);
        const sizeGenerator = gs.integers({ minValue: 0, maxValue: 2000 });
        const gapGenerator = gs.sampledFrom([0, 0.5, 23.5, 24, 24.5, 100, 500]);

        const eventGenerator = gs.record({
          input: inputGenerator,
          kind: kindGenerator,
          size: sizeGenerator,
          gap: gapGenerator,
        });
        const eventsGenerator = gs.arrays(eventGenerator, {
          minSize: 1,
          maxSize: 45,
        });

        const initialHeight = tc.draw(initialHeightGenerator);
        const events = tc.draw(eventsGenerator);
        const b = browser(initialHeight);

        // The oracle records semantic user intent, never component state or the
        // implementation's comparison against previous scroll event positions.
        let following = true;
        let expected = 0;

        try {
          b.settle();
          expected = b.max();

          for (const event of events) {
            const wasFollowing = following;
            const beforeEvent = b.top;

            switch (event.kind) {
              case "text":
                b.geometry(b.height + event.size);
                b.update();
                break;
              case "panel":
                b.geometry(b.height + event.size);
                break;
              case "viewport":
                b.geometry(b.height, 50 + event.size);
                break;
              case "shrink":
                b.geometry(event.size);
                break;
              case "scroll":
                b.scroll();
                break;
              case "resize":
                b.resize();
                break;
              case "timer":
                b.tick();
                break;
              case "user": {
                b.scroll();

                const before = b.top;
                const maximum = b.max();
                const requestedTop = maximum - event.gap;
                const target = Math.max(0, requestedTop);

                b.user(target, event.input);

                if (maximum - target <= 24) {
                  if (target > before) following = true;
                } else if (target < before) following = false;
                break;
              }
              case "elastic": {
                const maximum = b.max();
                if (following && b.top === maximum) {
                  const overshoot = maximum + event.gap;
                  b.elastic(overshoot);
                  b.elastic(maximum);
                }
                break;
              }
              case "hidden":
                b.hidden(event.size % 2 === 0);
                break;
              case "visible":
                b.visibility(event.size % 2 === 0);
                break;
              case "session": {
                const retired = b.observers.at(-1)!;

                b.switchSession();
                following = true;

                act(() => retired.deliver());
                break;
              }
              case "prepend": {
                const before = b.top;

                await b.prepend(event.size);
                following = false;

                const maximum = b.max();
                const compensatedTop = before + event.size;
                const expectedTop = Math.min(compensatedTop, maximum);
                expect(b.top).toBe(expectedTop);
                break;
              }
            }

            if (
              !wasFollowing &&
              !following &&
              event.kind !== "user" &&
              event.kind !== "prepend"
            ) {
              const maximum = b.max();
              const expectedTop = Math.min(beforeEvent, maximum);
              expect(b.top).toBe(expectedTop);
            }

            if (!following) {
              expected = b.top;
              b.resize();
              b.tick();
              b.scroll();

              expect(b.top).toBe(expected);
            }
          }

          b.hidden(false);
          b.visibility(true);
          b.settle();

          const settledTop = following ? b.max() : expected;
          expect(b.top).toBe(settledTop);

          b.geometry(b.height + 100);
          b.resize();
          b.unmount();

          const writes = b.writes;
          b.deliverRetiredObservers();
          b.tick();
          expect(b.writes).toBe(writes);
        } finally {
          b.unmount();
          vi.useRealTimers();
          vi.restoreAllMocks();
          vi.unstubAllGlobals();
        }
      },
      { testCases: 1000 }
    ),
  30_000
);

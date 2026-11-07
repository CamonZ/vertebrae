import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ChatInput } from "./ChatInput";

let contentHeight = 43;
let resize: ResizeObserverCallback;
const observe = vi.fn();
const disconnect = vi.fn();

beforeEach(() => {
  contentHeight = 43;
  vi.spyOn(HTMLElement.prototype, "scrollHeight", "get").mockImplementation(
    () => contentHeight
  );
  vi.stubGlobal(
    "ResizeObserver",
    class {
      constructor(callback: ResizeObserverCallback) {
        resize = callback;
      }
      observe = observe;
      disconnect = disconnect;
    }
  );
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  observe.mockClear();
  disconnect.mockClear();
});

function composer(value: string) {
  return (
    <ChatInput
      value={value}
      onChange={vi.fn()}
      onSubmit={vi.fn()}
      ariaLabel="Message"
    />
  );
}

describe("ChatInput sizing", () => {
  it("does not transiently shrink the focused input or write its height on single-line keystrokes", () => {
    const { rerender } = render(composer(""));
    const input = screen.getByRole("textbox", { name: "Message" });
    input.focus();
    expect(input.style.height).toBe("43px");

    // WebKit can lay out auto at 42.5px but report scrollHeight as 43.
    // Any intermediate height write can clamp the neighboring transcript;
    // checking only the final height would miss that movement.
    const writes = vi.spyOn(input.style, "height", "set");
    const liveMeasurement = vi.fn(() => contentHeight);
    Object.defineProperty(input, "scrollHeight", {
      configurable: true,
      get: liveMeasurement,
    });
    for (const value of ["a", "ab", "abc", "ab", "a", ""]) {
      rerender(composer(value));
      expect(input).toHaveFocus();
      expect(input.style.height).toBe("43px");
    }
    expect(writes).not.toHaveBeenCalled();
    expect(liveMeasurement).not.toHaveBeenCalled();
  });

  it("grows, caps and shrinks using content height without resetting the live height", () => {
    const { rerender } = render(composer("one"));
    const input = screen.getByRole("textbox", { name: "Message" });
    const writes = vi.spyOn(input.style, "height", "set");

    for (const [height, value, expected, overflow] of [
      [67, "one\ntwo", "67px", "hidden"],
      [300, "many\nlines", "160px", "auto"],
      [350, "more\nlines", "160px", "auto"],
      [43, "one", "43px", "hidden"],
      [20, "", "40px", "hidden"],
    ] as const) {
      contentHeight = height;
      rerender(composer(value));
      expect(input.style.height).toBe(expected);
      expect(input.style.overflowY).toBe(overflow);
    }
    expect(writes.mock.calls.map(([height]) => height)).toEqual([
      "67px",
      "160px",
      "43px",
      "40px",
    ]);
  });

  it("remeasures wrapped content on width changes and releases the observer", () => {
    const { unmount } = render(
      composer("a draft that wraps in a narrow panel")
    );
    const input = screen.getByRole("textbox", { name: "Message" });
    contentHeight = 91;
    act(() => resize([], {} as ResizeObserver));
    expect(input.style.height).toBe("91px");
    contentHeight = 43;
    act(() => resize([], {} as ResizeObserver));
    expect(input.style.height).toBe("43px");
    expect(observe).toHaveBeenCalledTimes(1);
    unmount();
    expect(disconnect).toHaveBeenCalledTimes(1);
  });

  it("measures an empty draft's placeholder without adding a second placeholder target", () => {
    const { container } = render(
      <ChatInput
        value=""
        placeholder="Write a message"
        onChange={vi.fn()}
        onSubmit={vi.fn()}
      />
    );
    expect(screen.getByPlaceholderText("Write a message")).toBeVisible();
    const measurement = container.querySelector<HTMLTextAreaElement>(
      'textarea[aria-hidden="true"]'
    )!;
    expect(measurement.value).toBe("Write a message");
    expect(measurement).not.toHaveAttribute("placeholder");
  });

  it("keeps the measurement input out of layout and keyboard/accessibility navigation", () => {
    const { container, rerender } = render(composer("draft"));
    const measurement = container.querySelector<HTMLTextAreaElement>(
      'textarea[aria-hidden="true"]'
    )!;
    expect(screen.getAllByRole("textbox")).toHaveLength(1);
    expect(measurement).toHaveAttribute("tabindex", "-1");
    expect(measurement).toHaveAttribute("readonly");
    expect(measurement.style.position).toBe("absolute");
    expect(measurement.style.visibility).toBe("hidden");
    expect(measurement.value).toBe("draft");
    rerender(composer("changed"));
    expect(measurement.value).toBe("changed");
  });
});

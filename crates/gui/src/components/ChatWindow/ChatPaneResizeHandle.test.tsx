import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { ChatPaneResizeHandle } from "./ChatPaneResizeHandle";

beforeEach(() => {
  class TestPointerEvent extends MouseEvent {
    pointerId: number;
    isPrimary: boolean;

    constructor(type: string, init: PointerEventInit = {}) {
      super(type, init);

      this.pointerId = init.pointerId ?? 1;
      this.isPrimary = init.isPrimary ?? true;
    }
  }

  vi.stubGlobal("PointerEvent", TestPointerEvent);

  document.body.style.cursor = "crosshair";
  document.body.style.userSelect = "text";
});

afterEach(() => {
  vi.unstubAllGlobals();
  document.body.removeAttribute("style");
});

function setup() {
  const onResize = vi.fn();
  const props = {
    leftWidth: 500,
    rightWidth: 600,
    label: "Resize pair",
    controls: "a b",
    layoutKey: "abc:1108",
    onResize,
  };

  const view = render(<ChatPaneResizeHandle {...props} />);
  const handle = screen.getByRole("separator");

  return { ...view, props, onResize, handle };
}

describe("chat pane separator", () => {
  it("exposes bounds and keyboard alternatives without starting a drag", () => {
    const { handle, onResize } = setup();

    expect(handle).toHaveAttribute("aria-valuemin", "360");
    expect(handle).toHaveAttribute("aria-valuemax", "740");
    expect(handle).toHaveAttribute("aria-valuenow", "500");

    for (const key of ["ArrowLeft", "ArrowRight", "Home", "End"]) {
      fireEvent.keyDown(handle, { key });
    }

    const deltas = onResize.mock.calls.flat();

    expect(deltas).toEqual([-16, 16, -140, 240]);
    expect(document.body.style.cursor).toBe("crosshair");
  });

  it("tracks both directions outside the handle and ignores other pointers", () => {
    const { handle, onResize } = setup();

    fireEvent.pointerDown(handle, { button: 0, clientX: 500, pointerId: 2 });
    fireEvent.pointerMove(document, { clientX: 600, pointerId: 3 });

    expect(onResize).not.toHaveBeenCalled();

    fireEvent.pointerMove(document, { clientX: 600, pointerId: 2 });
    fireEvent.pointerMove(document, { clientX: 400, pointerId: 2 });

    const deltas = onResize.mock.calls.flat();
    expect(deltas).toEqual([100, -100]);

    fireEvent.pointerUp(document, { pointerId: 2 });
    fireEvent.pointerMove(document, { clientX: 700, pointerId: 2 });

    expect(onResize).toHaveBeenCalledTimes(2);
    expect(document.body.style.cursor).toBe("crosshair");
    expect(document.body.style.userSelect).toBe("text");
  });

  it("restores inline selection values and priorities, including WebKit's spelling", () => {
    // jsdom does not implement this WebKit CSS property, so exercise the CSSOM
    // contract explicitly; the native WKWebView check verifies actual support.
    const style = document.body.style;
    const getValue = style.getPropertyValue.bind(style);
    const getPriority = style.getPropertyPriority.bind(style);

    const valueSpy = vi.spyOn(style, "getPropertyValue");
    valueSpy.mockImplementation((name) =>
      name === "-webkit-user-select" ? "all" : getValue(name)
    );

    const prioritySpy = vi.spyOn(style, "getPropertyPriority");
    prioritySpy.mockImplementation((name) =>
      name === "-webkit-user-select" ? "important" : getPriority(name)
    );

    const setProperty = vi.spyOn(style, "setProperty");
    const { handle } = setup();

    fireEvent.pointerDown(handle, { button: 0 });

    expect(setProperty).toHaveBeenCalledWith("-webkit-user-select", "none");

    fireEvent.pointerCancel(document);

    expect(setProperty).toHaveBeenCalledWith(
      "-webkit-user-select",
      "all",
      "important"
    );

    vi.restoreAllMocks();
  });

  it("ignores non-primary starts", () => {
    const { handle, onResize } = setup();

    fireEvent.pointerDown(handle, { button: 2 });
    fireEvent.pointerDown(handle, { button: 0, isPrimary: false });
    fireEvent.pointerMove(document, { clientX: 700 });

    expect(onResize).not.toHaveBeenCalled();
    expect(document.body.style.userSelect).toBe("text");
  });

  it.each(["cancel", "capture", "blur", "unmount", "layout"])(
    "retires the gesture on %s and restores prior body styles",
    (reason) => {
      const { handle, onResize, unmount, rerender, props } = setup();

      fireEvent.pointerDown(handle, { button: 0, clientX: 500 });

      expect(document.body.style.userSelect).toBe("none");

      if (reason === "cancel") fireEvent.pointerCancel(document);
      if (reason === "capture") fireEvent.lostPointerCapture(handle);
      if (reason === "blur") {
        const blurEvent = new Event("blur");

        fireEvent(window, blurEvent);
      }
      if (reason === "unmount") unmount();
      if (reason === "layout") {
        rerender(<ChatPaneResizeHandle {...props} layoutKey="changed" />);
      }

      fireEvent.pointerMove(document, { clientX: 600 });

      expect(onResize).not.toHaveBeenCalled();
      expect(document.body.style.cursor).toBe("crosshair");
      expect(document.body.style.userSelect).toBe("text");
    }
  );
});

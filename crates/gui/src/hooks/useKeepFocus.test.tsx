import { useRef, useState } from "react";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useKeepFocus } from "./useKeepFocus";

function Kept({ label = "kept" }: { label?: string }) {
  const ref = useRef<HTMLTextAreaElement>(null);
  useKeepFocus(ref);
  return <textarea ref={ref} aria-label={label} defaultValue="hello world" />;
}

function Pane({ showKept }: { showKept: boolean }) {
  return (
    <div data-pane-id="pane-1">
      <textarea data-testid="local-chat-composer" aria-label="composer" />
      {showKept && <Kept />}
    </div>
  );
}

const kept = () => screen.getByRole("textbox", { name: "kept" });
const frame = () =>
  act(() => {
    vi.runOnlyPendingTimers();
  });

/** Make the browser report that nothing holds focus, as WebKit does when a
 * shadow-root slot re-renders under a focused input without any event. */
function loseFocusSilently() {
  Object.defineProperty(document, "activeElement", {
    configurable: true,
    get: () => document.body,
  });
  return () => {
    delete (document as unknown as { activeElement?: Element }).activeElement;
  };
}

describe("useKeepFocus", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["requestAnimationFrame", "performance"] });
    vi.spyOn(document, "hasFocus").mockReturnValue(true);
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("takes focus and selection back after losing it to nothing without a user action", () => {
    render(<Kept />);
    const input = kept() as HTMLTextAreaElement;
    input.focus();
    input.setSelectionRange(2, 5);

    act(() => input.blur());
    expect(document.activeElement).toBe(document.body);
    frame();

    expect(input).toHaveFocus();
    expect([input.selectionStart, input.selectionEnd]).toEqual([2, 5]);
  });

  it("lets a pointer press, Tab, Escape or a shortcut move focus away", () => {
    render(<Kept />);
    const input = kept();
    for (const intent of [
      () => fireEvent.pointerDown(document.body),
      () => fireEvent.keyDown(input, { key: "Tab" }),
      () => fireEvent.keyDown(input, { key: "Escape" }),
      () => fireEvent.keyDown(input, { key: "k", metaKey: true }),
    ]) {
      input.focus();
      intent();
      act(() => input.blur());
      frame();
      expect(input).not.toHaveFocus();
      vi.advanceTimersByTime(1000);
    }
  });

  it("does not count typing, Enter or caret keys as moving focus", () => {
    render(<Kept />);
    const input = kept();
    input.focus();
    fireEvent.keyDown(input, { key: "a" });
    fireEvent.keyDown(input, { key: "Enter" });
    fireEvent.keyDown(input, { key: "ArrowLeft" });

    act(() => input.blur());
    frame();

    expect(input).toHaveFocus();
  });

  it("never undoes focus moved to another element", () => {
    render(
      <>
        <Kept />
        <button type="button">Elsewhere</button>
      </>
    );
    kept().focus();
    act(() => screen.getByRole("button", { name: "Elsewhere" }).focus());
    frame();

    expect(screen.getByRole("button", { name: "Elsewhere" })).toHaveFocus();
  });

  it("does not fight the window losing focus", () => {
    render(<Kept />);
    const input = kept();
    input.focus();
    vi.mocked(document.hasFocus).mockReturnValue(false);

    act(() => input.blur());
    frame();

    expect(input).not.toHaveFocus();
  });

  it("recovers a silent loss when the shadow tree it is slotted into re-renders", () => {
    const host = document.createElement("div");
    const shadow = host.attachShadow({ mode: "open" });
    shadow.append(document.createElement("slot"));
    document.body.append(host);
    render(<Kept />, { container: host });
    const input = kept();
    input.focus();

    const focus = vi.spyOn(input, "focus");
    const restoreActive = loseFocusSilently();
    act(() => {
      shadow.replaceChildren(document.createElement("slot"));
    });
    // MutationObserver callbacks are microtasks.
    return Promise.resolve().then(() => {
      frame();
      restoreActive();
      expect(focus).toHaveBeenCalledWith({ preventScroll: true });
      host.remove();
    });
  });

  it("hands focus to the pane's composer when it unmounts while focused", () => {
    const { rerender } = render(<Pane showKept />);
    kept().focus();

    rerender(<Pane showKept={false} />);
    frame();

    expect(screen.getByRole("textbox", { name: "composer" })).toHaveFocus();
  });

  it("does not move focus on unmount when it was not focused", () => {
    function Harness() {
      const [show, setShow] = useState(true);
      return (
        <div data-pane-id="pane-1">
          <textarea data-testid="local-chat-composer" aria-label="composer" />
          <button type="button" onClick={() => setShow(false)}>
            Hide
          </button>
          {show && <Kept />}
        </div>
      );
    }
    render(<Harness />);
    const hide = screen.getByRole("button", { name: "Hide" });
    hide.focus();
    fireEvent.click(hide);
    frame();

    expect(hide).toHaveFocus();
  });
});

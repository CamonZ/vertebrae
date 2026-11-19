import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { useRef } from "react";
import { useTranscriptCursor } from "./useTranscriptCursor";
import {
  TRANSCRIPT_HTML,
  installTranscriptLayout,
  layout,
  layoutTranscript,
  uninstallTranscriptLayout,
} from "../../test/transcriptLayout";

function Harness({ onExit }: { onExit: () => void }) {
  const viewportRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const overlayRef = useRef<HTMLDivElement>(null);
  const cursor = useTranscriptCursor({
    viewportRef,
    contentRef,
    overlayRef,
    onExit,
  });
  return (
    <>
      <div
        ref={viewportRef}
        tabIndex={-1}
        data-testid="viewport"
        data-cursor={cursor.state}
        onFocus={cursor.onFocus}
        onBlur={cursor.onBlur}
        onKeyDown={cursor.onKeyDown}
        onPointerDown={cursor.onPointerDown}
      >
        <div ref={overlayRef} data-testid="overlay" />
        <div
          ref={(element) => {
            // Written once, so re-renders keep the laid-out nodes.
            if (element && !element.childElementCount)
              element.innerHTML = TRANSCRIPT_HTML;
            contentRef.current = element;
          }}
          data-testid="content"
        />
      </div>
      <div className="chat-comment-card">
        <textarea aria-label="comment" />
      </div>
      <textarea aria-label="composer" />
    </>
  );
}

const frame = () =>
  act(
    () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve()))
  );

async function setup() {
  const onExit = vi.fn();
  render(<Harness onExit={onExit} />);
  const viewport = screen.getByTestId("viewport");
  // A viewport whose bottom edge cuts the last list item.
  layout(viewport, { left: 80, top: 0, width: 520, height: 135 });
  Object.defineProperty(viewport, "clientHeight", { value: 135 });
  viewport.scrollTo = vi.fn();
  layoutTranscript(screen.getByTestId("content"));
  act(() => viewport.focus());
  await frame();
  return { viewport, onExit, overlay: screen.getByTestId("overlay") };
}

const key = (target: HTMLElement, init: KeyboardEventInit & { key: string }) =>
  fireEvent.keyDown(target, init);

/** The caret's position in viewport content space (the viewport is at x=80). */
const caret = (overlay: HTMLElement) => [
  overlay.style.getPropertyValue("--caret-x"),
  overlay.style.getPropertyValue("--caret-y"),
];

const selected = () => window.getSelection()?.toString() ?? "";

beforeEach(installTranscriptLayout);
afterEach(() => {
  vi.restoreAllMocks();
  uninstallTranscriptLayout();
  window.getSelection()?.removeAllRanges();
});

describe("useTranscriptCursor", () => {
  it("starts at the start of the last fully visible line when focused from the keyboard", async () => {
    const { viewport, overlay } = await setup();
    expect(viewport).toHaveAttribute("data-cursor", "active");
    expect(overlay.dataset.state).toBe("active");
    expect(caret(overlay)).toEqual(["20px", "100px"]);
    // A block over the first character.
    expect(overlay.style.getPropertyValue("--caret-width")).toBe("8px");
    expect(overlay.style.getPropertyValue("--caret-height")).toBe("20px");
  });

  it("moves by character and line without touching the DOM selection", async () => {
    const { viewport, overlay } = await setup();
    expect(key(viewport, { key: "ArrowRight" })).toBe(false);
    expect(caret(overlay)).toEqual(["28px", "100px"]);
    key(viewport, { key: "ArrowUp" });
    expect(caret(overlay)).toEqual(["28px", "80px"]);
    // The tool group between the items is stepped over.
    key(viewport, { key: "ArrowUp" });
    expect(caret(overlay)).toEqual(["28px", "0px"]);
    expect(window.getSelection()?.isCollapsed ?? true).toBe(true);
  });

  it("keeps the column through a shorter line", async () => {
    const { viewport, overlay } = await setup();
    key(viewport, { key: "ArrowUp" });
    key(viewport, { key: "ArrowRight", metaKey: true });
    // The end of "first line ", x=188 (viewport x 108).
    expect(caret(overlay)).toEqual(["108px", "80px"]);
    key(viewport, { key: "ArrowDown" });
    // "second" ends at x=148.
    expect(caret(overlay)).toEqual(["68px", "100px"]);
    key(viewport, { key: "ArrowDown" });
    // Back to x=188 is past "  item one", which ends at x=180.
    expect(caret(overlay)).toEqual(["100px", "120px"]);
  });

  it("moves by word, paragraph, line end and item with ⌥ and ⌘", async () => {
    const { viewport, overlay } = await setup();
    key(viewport, { key: "ArrowRight", altKey: true });
    expect(caret(overlay)).toEqual(["68px", "100px"]);
    key(viewport, { key: "ArrowDown", altKey: true });
    expect(caret(overlay)).toEqual(["100px", "120px"]);
    key(viewport, { key: "ArrowLeft", metaKey: true });
    expect(caret(overlay)).toEqual(["20px", "120px"]);
    key(viewport, { key: "ArrowUp", metaKey: true });
    expect(caret(overlay)).toEqual(["20px", "80px"]);
    key(viewport, { key: "ArrowUp", metaKey: true });
    expect(caret(overlay)).toEqual(["20px", "0px"]);
  });

  it("leaves ⌘⌥ arrows to the pane", async () => {
    const { viewport, overlay } = await setup();
    expect(key(viewport, { key: "ArrowUp", metaKey: true, altKey: true })).toBe(
      true
    );
    expect(caret(overlay)).toEqual(["20px", "100px"]);
  });

  it("selects as Shift moves the caret, from a fixed anchor", async () => {
    const { viewport, overlay } = await setup();
    key(viewport, { key: "ArrowRight", altKey: true, shiftKey: true });
    expect(selected()).toBe("second");
    expect(caret(overlay)).toEqual(["68px", "100px"]);

    key(viewport, { key: "ArrowUp", shiftKey: true });
    // Back above the anchor: from x=148 on the first line to the anchor.
    const selection = window.getSelection()!;
    const p = screen.getByTestId("content").querySelector("p")!.firstChild!;
    expect(selection.anchorNode).toBe(p);
    expect(selection.anchorOffset).toBe(11);
    expect(selection.focusOffset).toBe(6);
    expect(selected()).toBe("line ");

    key(viewport, { key: "ArrowDown", metaKey: true, shiftKey: true });
    // To the item's end: from the anchor across the list item.
    expect(selected()).toBe("second  item one");
  });

  it("collapses a selection to the arrow's side", async () => {
    const { viewport, overlay } = await setup();
    key(viewport, { key: "ArrowRight", altKey: true, shiftKey: true });
    key(viewport, { key: "ArrowLeft" });
    expect(window.getSelection()?.isCollapsed ?? true).toBe(true);
    expect(caret(overlay)).toEqual(["20px", "100px"]);
  });

  it("collapses a selection on Esc, then leaves on the next Esc", async () => {
    const { viewport, onExit } = await setup();
    key(viewport, { key: "ArrowUp", shiftKey: true });
    expect(window.getSelection()?.isCollapsed).toBe(false);

    key(viewport, { key: "Escape" });
    expect(window.getSelection()?.isCollapsed ?? true).toBe(true);
    expect(onExit).not.toHaveBeenCalled();

    key(viewport, { key: "Escape" });
    expect(onExit).toHaveBeenCalledTimes(1);
  });

  it("dims while its comment card has focus and resumes at the same place", async () => {
    const { viewport, overlay } = await setup();
    key(viewport, { key: "Home" });
    expect(caret(overlay)).toEqual(["20px", "0px"]);

    act(() => screen.getByLabelText("comment").focus());
    expect(viewport).toHaveAttribute("data-cursor", "passive");
    act(() => viewport.focus());
    await frame();
    expect(viewport).toHaveAttribute("data-cursor", "active");
    expect(caret(overlay)).toEqual(["20px", "0px"]);
  });

  it("drops the caret when focus moves elsewhere and restarts on re-entry", async () => {
    const { viewport, overlay } = await setup();
    key(viewport, { key: "Home" });
    act(() => screen.getByLabelText("composer").focus());
    expect(viewport).toHaveAttribute("data-cursor", "off");
    act(() => viewport.focus());
    await frame();
    expect(caret(overlay)).toEqual(["20px", "100px"]);
  });

  it("hands the transcript back to the mouse on a pointer press", async () => {
    const { viewport } = await setup();
    act(() => screen.getByLabelText("composer").focus());
    fireEvent.pointerDown(viewport);
    act(() => viewport.focus());
    await frame();
    expect(viewport).toHaveAttribute("data-cursor", "off");
    // Arrow keys keep scrolling natively.
    expect(key(viewport, { key: "ArrowDown" })).toBe(true);
  });
});

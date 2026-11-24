import { describe, expect, it, beforeEach, vi } from "vitest";
import { cleanup, render, screen, fireEvent } from "@testing-library/react";
import * as hegel from "@hegeldev/hegel";
import * as gs from "@hegeldev/hegel/generators";
import { OWNS_ESCAPE_ATTRIBUTE, useGlassPanel } from "./useGlassPanel";
import { usePanelFocusStore } from "../stores/panelFocusStore";

function Panel({
  id,
  isOpen,
  onClose,
  shouldHandleEscape,
}: {
  id: string;
  isOpen: boolean;
  onClose: () => void;
  shouldHandleEscape?: () => boolean;
}) {
  const { isFocused, focusProps } = useGlassPanel({
    id,
    isOpen,
    onClose,
    shouldHandleEscape,
  });
  if (!isOpen) return null;
  return (
    <div data-testid={id} data-focused={isFocused || undefined} {...focusProps}>
      {id}
    </div>
  );
}

describe("useGlassPanel", () => {
  beforeEach(() => usePanelFocusStore.getState().reset());

  it("marks the most recently opened panel as focused", () => {
    render(
      <>
        <Panel id="a" isOpen onClose={vi.fn()} />
        <Panel id="b" isOpen onClose={vi.fn()} />
      </>
    );

    expect(screen.getByTestId("a")).not.toHaveAttribute("data-focused");
    expect(screen.getByTestId("b")).toHaveAttribute("data-focused", "true");
  });

  it("Escape closes only the focused panel", () => {
    const closeA = vi.fn();
    const closeB = vi.fn();
    render(
      <>
        <Panel id="a" isOpen onClose={closeA} />
        <Panel id="b" isOpen onClose={closeB} />
      </>
    );

    fireEvent.keyDown(window, { key: "Escape" });

    expect(closeB).toHaveBeenCalledTimes(1);
    expect(closeA).not.toHaveBeenCalled();
  });

  it("interacting with a background panel refocuses it, redirecting Escape", () => {
    const closeA = vi.fn();
    const closeB = vi.fn();
    render(
      <>
        <Panel id="a" isOpen onClose={closeA} />
        <Panel id="b" isOpen onClose={closeB} />
      </>
    );

    // Click panel A → it becomes focused.
    fireEvent.mouseDown(screen.getByTestId("a"));
    expect(screen.getByTestId("a")).toHaveAttribute("data-focused", "true");

    fireEvent.keyDown(window, { key: "Escape" });
    expect(closeA).toHaveBeenCalledTimes(1);
    expect(closeB).not.toHaveBeenCalled();
  });

  it("declines Escape when the panel's guard returns false", () => {
    const closeA = vi.fn();
    render(
      <Panel id="a" isOpen onClose={closeA} shouldHandleEscape={() => false} />
    );

    fireEvent.keyDown(window, { key: "Escape" });
    expect(closeA).not.toHaveBeenCalled();
  });

  it("defers Escape to an open modal/dialog", () => {
    const closeA = vi.fn();
    render(
      <>
        <Panel id="a" isOpen onClose={closeA} />
        <div role="dialog" aria-modal="true">
          modal
        </div>
      </>
    );

    fireEvent.keyDown(window, { key: "Escape" });
    expect(closeA).not.toHaveBeenCalled();
  });

  it("leaves Escape to focused content that owns it", () => {
    const closeA = vi.fn();
    render(
      <>
        <Panel id="a" isOpen onClose={closeA} />
        <div data-owns-escape="">
          <button type="button">chip</button>
        </div>
      </>
    );

    screen.getByRole("button", { name: "chip" }).focus();
    fireEvent.keyDown(window, { key: "Escape" });
    expect(closeA).not.toHaveBeenCalled();

    screen.getByRole("button", { name: "chip" }).blur();
    fireEvent.keyDown(window, { key: "Escape" });
    expect(closeA).toHaveBeenCalledTimes(1);
  });

  it("leaves Escape to a floating card that claims it, wherever focus is", () => {
    const closeA = vi.fn();
    render(
      <>
        <Panel id="a" isOpen onClose={closeA} />
        <div data-escape-claim="">card</div>
      </>
    );
    fireEvent.keyDown(window, { key: "Escape" });
    expect(closeA).not.toHaveBeenCalled();
  });

  it("unregisters on close so the next panel becomes focused", () => {
    const { rerender } = render(
      <>
        <Panel id="a" isOpen onClose={vi.fn()} />
        <Panel id="b" isOpen onClose={vi.fn()} />
      </>
    );
    expect(screen.getByTestId("b")).toHaveAttribute("data-focused", "true");

    rerender(
      <>
        <Panel id="a" isOpen onClose={vi.fn()} />
        <Panel id="b" isOpen={false} onClose={vi.fn()} />
      </>
    );

    expect(screen.getByTestId("a")).toHaveAttribute("data-focused", "true");
  });
});

describe("Escape ownership", () => {
  beforeEach(() => usePanelFocusStore.getState().reset());

  // Escape closes the focused panel unless a dialog is up, its guard
  // declines, or focus sits inside content that owns Escape (ticket
  // 3845ab6b). The expectation comes from the generated tree, not the DOM.
  it("closes the panel exactly when nothing focused or modal owns Escape", () =>
    hegel.test(
      (tc) => {
        const levels = tc.draw(
          gs.arrays(gs.booleans(), { minSize: 1, maxSize: 4 })
        );
        const focusDepth = tc.draw(
          gs.integers({ minValue: -1, maxValue: levels.length - 1 })
        );
        const inPanel = tc.draw(gs.booleans());
        const dialog = tc.draw(gs.booleans());
        const guard = tc.draw(gs.booleans());
        const onClose = vi.fn();

        // Nested elements; level i owns Escape when levels[i] is true.
        const nest = (depth: number): React.ReactNode =>
          depth === levels.length ? null : (
            <div
              {...(levels[depth] ? { [OWNS_ESCAPE_ATTRIBUTE]: "" } : {})}
              tabIndex={-1}
              data-testid={`level-${depth}`}
            >
              {nest(depth + 1)}
            </div>
          );
        try {
          render(
            <>
              <PanelWith id="p" onClose={onClose} guard={guard}>
                {inPanel ? nest(0) : null}
              </PanelWith>
              {inPanel ? null : nest(0)}
              {dialog ? <div role="dialog">modal</div> : null}
            </>
          );
          if (focusDepth >= 0)
            screen.getByTestId(`level-${focusDepth}`).focus();

          fireEvent.keyDown(window, { key: "Escape" });

          const owned =
            focusDepth >= 0 && levels.slice(0, focusDepth + 1).some(Boolean);
          const closes = !dialog && !owned && guard;
          expect(onClose).toHaveBeenCalledTimes(closes ? 1 : 0);
        } finally {
          cleanup();
          usePanelFocusStore.getState().reset();
        }
      },
      { testCases: 150 }
    ));
});

function PanelWith({
  id,
  onClose,
  guard,
  children,
}: {
  id: string;
  onClose: () => void;
  guard: boolean;
  children: React.ReactNode;
}) {
  const { focusProps } = useGlassPanel({
    id,
    isOpen: true,
    onClose,
    shouldHandleEscape: () => guard,
  });
  return <div {...focusProps}>{children}</div>;
}

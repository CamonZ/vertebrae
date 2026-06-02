import { describe, expect, it, beforeEach, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { useGlassPanel } from "./useGlassPanel";
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
      <Panel
        id="a"
        isOpen
        onClose={closeA}
        shouldHandleEscape={() => false}
      />
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

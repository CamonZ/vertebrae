import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { useSidebarResize } from "./useSidebarResize";

afterEach(() => vi.unstubAllGlobals());

it("clamps captured pointer drags on window shrink and restores the preferred width", () => {
  let observe!: (width: number) => void;
  const disconnect = vi.fn();
  vi.stubGlobal(
    "ResizeObserver",
    class {
      constructor(callback: ResizeObserverCallback) {
        observe = (width) =>
          callback(
            [{ contentRect: { width } } as ResizeObserverEntry],
            this as unknown as ResizeObserver
          );
      }
      observe() {}
      disconnect = disconnect;
    }
  );
  vi.stubGlobal("PointerEvent", MouseEvent);

  function Fixture() {
    const { containerRef, handleProps } = useSidebarResize();
    return (
      <div ref={containerRef}>
        <div {...handleProps} />
      </div>
    );
  }

  const { unmount } = render(<Fixture />);
  const handle = screen.getByRole("separator");
  handle.setPointerCapture = vi.fn();
  handle.releasePointerCapture = vi.fn();

  fireEvent.pointerDown(handle, { button: 0, clientX: 240 });
  fireEvent.pointerMove(handle, { clientX: 340 });
  expect(handle).toHaveAttribute("aria-valuenow", "340");
  fireEvent.pointerUp(handle);

  act(() => observe(400));
  expect(handle).toHaveAttribute("aria-valuenow", "220");
  act(() => observe(800));
  expect(handle).toHaveAttribute("aria-valuenow", "340");

  fireEvent.pointerDown(handle, { button: 0, clientX: 340 });
  fireEvent.pointerCancel(handle);
  fireEvent.pointerMove(handle, { clientX: 700 });
  expect(handle).toHaveAttribute("aria-valuenow", "340");
  unmount();

  expect(disconnect).toHaveBeenCalledOnce();
});

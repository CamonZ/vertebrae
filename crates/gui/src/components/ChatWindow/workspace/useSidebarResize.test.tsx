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

  expect(handle).toHaveFocus();

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

it("resizes the right Changes panel with keyboard direction and a usable minimum", () => {
  function Fixture() {
    const { containerRef, handleProps } = useSidebarResize({
      initial: 450,
      side: "right",
      label: "Resize Changes panel",
    });

    return (
      <div ref={containerRef}>
        <div {...handleProps} />
      </div>
    );
  }

  render(<Fixture />);

  const handle = screen.getByRole("separator", {
    name: "Resize Changes panel",
  });

  fireEvent.keyDown(handle, { key: "ArrowLeft" });

  expect(handle).toHaveAttribute("aria-valuenow", "460");

  fireEvent.keyDown(handle, { key: "Home" });

  expect(handle).toHaveAttribute("aria-valuenow", "180");

  fireEvent.keyDown(handle, { key: "ArrowRight" });

  expect(handle).toHaveAttribute("aria-valuenow", "180");
});

it("lets the Changes splitter grow beyond fixed pixel and percentage caps", () => {
  let observe!: (width: number) => void;

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
      disconnect() {}
    }
  );
  vi.stubGlobal("PointerEvent", MouseEvent);

  function Fixture() {
    const { containerRef, handleProps } = useSidebarResize({
      initial: 560,
      side: "right",
    });

    return (
      <div ref={containerRef}>
        <div {...handleProps} />
      </div>
    );
  }

  render(<Fixture />);

  const handle = screen.getByRole("separator");

  handle.setPointerCapture = vi.fn();
  handle.releasePointerCapture = vi.fn();
  act(() => observe(2400));

  fireEvent.pointerDown(handle, { button: 0, clientX: 800 });
  fireEvent.pointerMove(handle, { clientX: -600 });

  expect(handle).toHaveAttribute("aria-valuenow", "1960");

  fireEvent.pointerUp(handle);
  fireEvent.keyDown(handle, { key: "End" });

  expect(handle).toHaveAttribute("aria-valuenow", "2218");

  act(() => observe(800));

  expect(handle).toHaveAttribute("aria-valuenow", "618");

  act(() => observe(2400));

  expect(handle).toHaveAttribute("aria-valuenow", "2218");
});

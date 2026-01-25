import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { screen, fireEvent } from "@testing-library/react";
import { render } from "../../test/test-utils";
import { ResizablePanel } from "./ResizablePanel";

// Mock localStorage
const localStorageMock = (() => {
  let store: Record<string, string> = {};
  return {
    getItem: vi.fn((key: string) => store[key] ?? null),
    setItem: vi.fn((key: string, value: string) => {
      store[key] = value;
    }),
    removeItem: vi.fn((key: string) => {
      delete store[key];
    }),
    clear: vi.fn(() => {
      store = {};
    }),
  };
})();

Object.defineProperty(window, "localStorage", { value: localStorageMock });

describe("ResizablePanel", () => {
  beforeEach(() => {
    localStorageMock.clear();
    vi.clearAllMocks();
  });

  afterEach(() => {
    // Clean up any global styles
    document.body.style.userSelect = "";
    document.body.style.cursor = "";
  });

  describe("rendering", () => {
    it("renders children", () => {
      render(
        <ResizablePanel>
          <div>Panel Content</div>
        </ResizablePanel>
      );
      expect(screen.getByText("Panel Content")).toBeInTheDocument();
    });

    it("renders with default width", () => {
      const { container } = render(
        <ResizablePanel>
          <div>Content</div>
        </ResizablePanel>
      );
      const panel = container.firstChild as HTMLElement;
      expect(panel.style.width).toBe("384px"); // DEFAULT_WIDTH
    });

    it("renders with custom default width", () => {
      const { container } = render(
        <ResizablePanel defaultWidth={500}>
          <div>Content</div>
        </ResizablePanel>
      );
      const panel = container.firstChild as HTMLElement;
      expect(panel.style.width).toBe("500px");
    });

    it("renders resize handle", () => {
      const { container } = render(
        <ResizablePanel>
          <div>Content</div>
        </ResizablePanel>
      );
      const resizeHandle = container.querySelector('[role="separator"]');
      expect(resizeHandle).toBeInTheDocument();
    });

    it("renders glow edge with default color", () => {
      const { container } = render(
        <ResizablePanel>
          <div>Content</div>
        </ResizablePanel>
      );
      // Check for glow edge element
      const glowEdge = container.querySelector(".bg-gradient-to-b");
      expect(glowEdge).toBeInTheDocument();
    });

    it("renders glow edge with custom color", () => {
      const { container } = render(
        <ResizablePanel glowColor="from-info/0 via-info/30 to-info/0">
          <div>Content</div>
        </ResizablePanel>
      );
      const glowEdge = container.querySelector(".from-info\\/0");
      expect(glowEdge).toBeInTheDocument();
    });

    it("applies custom className", () => {
      const { container } = render(
        <ResizablePanel className="custom-class">
          <div>Content</div>
        </ResizablePanel>
      );
      const panel = container.firstChild as HTMLElement;
      expect(panel).toHaveClass("custom-class");
    });
  });

  describe("localStorage persistence", () => {
    it("saves width to localStorage when storageKey provided", () => {
      render(
        <ResizablePanel storageKey="test-panel-width" defaultWidth={400}>
          <div>Content</div>
        </ResizablePanel>
      );
      expect(localStorageMock.setItem).toHaveBeenCalledWith(
        "test-panel-width",
        "400"
      );
    });

    it("loads width from localStorage when storageKey provided", () => {
      localStorageMock.getItem.mockReturnValueOnce("450");

      const { container } = render(
        <ResizablePanel storageKey="test-panel-width">
          <div>Content</div>
        </ResizablePanel>
      );

      const panel = container.firstChild as HTMLElement;
      expect(panel.style.width).toBe("450px");
    });

    it("uses default width when localStorage value is invalid", () => {
      localStorageMock.getItem.mockReturnValueOnce("invalid");

      const { container } = render(
        <ResizablePanel storageKey="test-panel-width" defaultWidth={400}>
          <div>Content</div>
        </ResizablePanel>
      );

      const panel = container.firstChild as HTMLElement;
      expect(panel.style.width).toBe("400px");
    });

    it("uses default width when localStorage value is out of range", () => {
      localStorageMock.getItem.mockReturnValueOnce("1000"); // Above maxWidth

      const { container } = render(
        <ResizablePanel storageKey="test-panel-width" defaultWidth={400} maxWidth={600}>
          <div>Content</div>
        </ResizablePanel>
      );

      const panel = container.firstChild as HTMLElement;
      expect(panel.style.width).toBe("400px");
    });

    it("does not access localStorage when no storageKey provided", () => {
      render(
        <ResizablePanel>
          <div>Content</div>
        </ResizablePanel>
      );
      // Should not have tried to get from localStorage
      expect(localStorageMock.getItem).not.toHaveBeenCalled();
    });
  });

  describe("resize handle accessibility", () => {
    it("has correct ARIA attributes", () => {
      const { container } = render(
        <ResizablePanel minWidth={200} maxWidth={500} defaultWidth={350}>
          <div>Content</div>
        </ResizablePanel>
      );

      const handle = container.querySelector('[role="separator"]');
      expect(handle).toHaveAttribute("aria-orientation", "vertical");
      expect(handle).toHaveAttribute("aria-valuenow", "350");
      expect(handle).toHaveAttribute("aria-valuemin", "200");
      expect(handle).toHaveAttribute("aria-valuemax", "500");
      expect(handle).toHaveAttribute("tabIndex", "0");
    });

    it("supports keyboard resize with ArrowLeft (increase width)", () => {
      const { container } = render(
        <ResizablePanel defaultWidth={400} maxWidth={600}>
          <div>Content</div>
        </ResizablePanel>
      );

      const handle = container.querySelector('[role="separator"]') as HTMLElement;
      fireEvent.keyDown(handle, { key: "ArrowLeft" });

      const panel = container.firstChild as HTMLElement;
      expect(panel.style.width).toBe("410px"); // 400 + 10
    });

    it("supports keyboard resize with ArrowRight (decrease width)", () => {
      const { container } = render(
        <ResizablePanel defaultWidth={400} minWidth={280}>
          <div>Content</div>
        </ResizablePanel>
      );

      const handle = container.querySelector('[role="separator"]') as HTMLElement;
      fireEvent.keyDown(handle, { key: "ArrowRight" });

      const panel = container.firstChild as HTMLElement;
      expect(panel.style.width).toBe("390px"); // 400 - 10
    });

    it("respects maxWidth on keyboard resize", () => {
      const { container } = render(
        <ResizablePanel defaultWidth={595} maxWidth={600}>
          <div>Content</div>
        </ResizablePanel>
      );

      const handle = container.querySelector('[role="separator"]') as HTMLElement;
      fireEvent.keyDown(handle, { key: "ArrowLeft" });

      const panel = container.firstChild as HTMLElement;
      expect(panel.style.width).toBe("600px"); // Clamped to max
    });

    it("respects minWidth on keyboard resize", () => {
      const { container } = render(
        <ResizablePanel defaultWidth={285} minWidth={280}>
          <div>Content</div>
        </ResizablePanel>
      );

      const handle = container.querySelector('[role="separator"]') as HTMLElement;
      fireEvent.keyDown(handle, { key: "ArrowRight" });

      const panel = container.firstChild as HTMLElement;
      expect(panel.style.width).toBe("280px"); // Clamped to min
    });
  });

  describe("mouse resize interactions", () => {
    it("starts resizing on mousedown", () => {
      const { container } = render(
        <ResizablePanel>
          <div>Content</div>
        </ResizablePanel>
      );

      const handle = container.querySelector('[role="separator"]') as HTMLElement;
      fireEvent.mouseDown(handle);

      // Should apply resizing styles to body
      expect(document.body.style.userSelect).toBe("none");
      expect(document.body.style.cursor).toBe("ew-resize");
    });

    it("stops resizing on mouseup", () => {
      const { container } = render(
        <ResizablePanel>
          <div>Content</div>
        </ResizablePanel>
      );

      const handle = container.querySelector('[role="separator"]') as HTMLElement;
      fireEvent.mouseDown(handle);
      fireEvent.mouseUp(document);

      // Should remove resizing styles from body
      expect(document.body.style.userSelect).toBe("");
      expect(document.body.style.cursor).toBe("");
    });

    it("shows visual feedback when resizing", () => {
      const { container } = render(
        <ResizablePanel>
          <div>Content</div>
        </ResizablePanel>
      );

      const handle = container.querySelector('[role="separator"]') as HTMLElement;
      expect(handle).not.toHaveClass("bg-primary/20");

      fireEvent.mouseDown(handle);
      expect(handle).toHaveClass("bg-primary/20");
    });
  });

  describe("width constraints", () => {
    it("uses custom minWidth", () => {
      const { container } = render(
        <ResizablePanel minWidth={300} defaultWidth={300}>
          <div>Content</div>
        </ResizablePanel>
      );

      const handle = container.querySelector('[role="separator"]') as HTMLElement;
      // Try to go below min
      fireEvent.keyDown(handle, { key: "ArrowRight" });
      fireEvent.keyDown(handle, { key: "ArrowRight" });
      fireEvent.keyDown(handle, { key: "ArrowRight" });

      const panel = container.firstChild as HTMLElement;
      expect(panel.style.width).toBe("300px"); // Should stay at min
    });

    it("uses custom maxWidth", () => {
      const { container } = render(
        <ResizablePanel maxWidth={500} defaultWidth={500}>
          <div>Content</div>
        </ResizablePanel>
      );

      const handle = container.querySelector('[role="separator"]') as HTMLElement;
      // Try to go above max
      fireEvent.keyDown(handle, { key: "ArrowLeft" });

      const panel = container.firstChild as HTMLElement;
      expect(panel.style.width).toBe("500px"); // Should stay at max
    });
  });
});

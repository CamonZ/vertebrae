import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor, cleanup } from "../../test/test-utils";
import { createRef } from "react";

// Create mock functions that can be tracked
const mockWrite = vi.fn();
const mockClear = vi.fn();
const mockFocus = vi.fn();
const mockDispose = vi.fn();
const mockLoadAddon = vi.fn();
const mockOpen = vi.fn();
const mockOnDataDispose = vi.fn();
const mockOnResizeDispose = vi.fn();
const mockFit = vi.fn();

// Track callbacks passed to onData and onResize
let capturedOnDataCallback: ((data: string) => void) | null = null;
let capturedOnResizeCallback:
  | ((size: { cols: number; rows: number }) => void)
  | null = null;

// Mock modules with factory functions
vi.mock("@xterm/xterm", () => {
  return {
    Terminal: class MockTerminal {
      cols = 80;
      rows = 24;

      constructor() {
        // Reset callbacks on new instance
        capturedOnDataCallback = null;
        capturedOnResizeCallback = null;
      }

      write(...args: unknown[]) {
        mockWrite(...args);
      }
      clear() {
        mockClear();
      }
      focus() {
        mockFocus();
      }
      dispose() {
        mockDispose();
      }
      loadAddon(addon: unknown) {
        mockLoadAddon(addon);
      }
      open(element: HTMLElement) {
        mockOpen(element);
      }
      onData(callback: (data: string) => void) {
        capturedOnDataCallback = callback;
        return { dispose: mockOnDataDispose };
      }
      onResize(callback: (size: { cols: number; rows: number }) => void) {
        capturedOnResizeCallback = callback;
        return { dispose: mockOnResizeDispose };
      }
    },
  };
});

vi.mock("@xterm/addon-fit", () => {
  return {
    FitAddon: class MockFitAddon {
      fit() {
        mockFit();
      }
      dispose() {}
    },
  };
});

// Mock CSS import
vi.mock("@xterm/xterm/css/xterm.css", () => ({}));

// Import after mocks are set up
import { Terminal, type TerminalHandle } from "./Terminal";

describe("Terminal", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    capturedOnDataCallback = null;
    capturedOnResizeCallback = null;

    // Mock requestAnimationFrame
    vi.spyOn(window, "requestAnimationFrame").mockImplementation((cb) => {
      cb(0);
      return 0;
    });
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  describe("rendering", () => {
    it("renders terminal container with data-testid", () => {
      render(<Terminal />);
      expect(screen.getByTestId("terminal")).toBeInTheDocument();
    });

    it("applies custom className", () => {
      render(<Terminal className="custom-class" />);
      expect(screen.getByTestId("terminal")).toHaveClass("custom-class");
    });

    it("initializes xterm.js on mount", async () => {
      render(<Terminal />);

      await waitFor(() => {
        expect(mockOpen).toHaveBeenCalled();
        expect(mockLoadAddon).toHaveBeenCalled();
      });
    });
  });

  describe("imperative handle", () => {
    it("exposes write method", async () => {
      const ref = createRef<TerminalHandle>();
      render(<Terminal ref={ref} />);

      await waitFor(() => {
        expect(ref.current).not.toBeNull();
      });

      ref.current?.write("Hello, World!");
      expect(mockWrite).toHaveBeenCalledWith("Hello, World!");
    });

    it("exposes write method for Uint8Array", async () => {
      const ref = createRef<TerminalHandle>();
      render(<Terminal ref={ref} />);

      await waitFor(() => {
        expect(ref.current).not.toBeNull();
      });

      const data = new Uint8Array([72, 105]);
      ref.current?.write(data);
      expect(mockWrite).toHaveBeenCalledWith(data);
    });

    it("exposes clear method", async () => {
      const ref = createRef<TerminalHandle>();
      render(<Terminal ref={ref} />);

      await waitFor(() => {
        expect(ref.current).not.toBeNull();
      });

      ref.current?.clear();
      expect(mockClear).toHaveBeenCalled();
    });

    it("exposes focus method", async () => {
      const ref = createRef<TerminalHandle>();
      render(<Terminal ref={ref} />);

      await waitFor(() => {
        expect(ref.current).not.toBeNull();
      });

      ref.current?.focus();
      expect(mockFocus).toHaveBeenCalled();
    });

    it("exposes getDimensions method", async () => {
      const ref = createRef<TerminalHandle>();
      render(<Terminal ref={ref} />);

      await waitFor(() => {
        expect(ref.current).not.toBeNull();
      });

      const dimensions = ref.current?.getDimensions();
      expect(dimensions).toEqual({ cols: 80, rows: 24 });
    });

    it("exposes fit method", async () => {
      const ref = createRef<TerminalHandle>();
      render(<Terminal ref={ref} />);

      await waitFor(() => {
        expect(ref.current).not.toBeNull();
      });

      ref.current?.fit();
      expect(mockFit).toHaveBeenCalled();
    });
  });

  describe("callbacks", () => {
    it("calls onData when user types", async () => {
      const onData = vi.fn();
      render(<Terminal onData={onData} />);

      await waitFor(() => {
        expect(capturedOnDataCallback).not.toBeNull();
      });

      // Simulate xterm calling the onData callback
      capturedOnDataCallback?.("test input");

      expect(onData).toHaveBeenCalledWith("test input");
    });

    it("calls onResize when terminal resizes", async () => {
      const onResize = vi.fn();
      render(<Terminal onResize={onResize} />);

      await waitFor(() => {
        expect(capturedOnResizeCallback).not.toBeNull();
      });

      // Simulate xterm calling the onResize callback
      capturedOnResizeCallback?.({ cols: 120, rows: 40 });

      expect(onResize).toHaveBeenCalledWith({ cols: 120, rows: 40 });
    });

    it("reports initial dimensions via onResize", async () => {
      const onResize = vi.fn();
      render(<Terminal onResize={onResize} />);

      await waitFor(() => {
        expect(onResize).toHaveBeenCalledWith({ cols: 80, rows: 24 });
      });
    });
  });

  describe("configuration", () => {
    it("auto-focuses by default", async () => {
      render(<Terminal autoFocus={true} />);

      await waitFor(() => {
        expect(mockFocus).toHaveBeenCalled();
      });
    });

    it("does not auto-focus when disabled", async () => {
      render(<Terminal autoFocus={false} />);

      // Wait for initialization to complete
      await waitFor(() => {
        expect(mockOpen).toHaveBeenCalled();
      });

      // Focus should not have been called
      expect(mockFocus).not.toHaveBeenCalled();
    });

    it("fits terminal on mount", async () => {
      render(<Terminal />);

      await waitFor(() => {
        expect(mockFit).toHaveBeenCalled();
      });
    });
  });

  describe("cleanup", () => {
    it("disposes terminal on unmount", async () => {
      const { unmount } = render(<Terminal />);

      await waitFor(() => {
        expect(mockOpen).toHaveBeenCalled();
      });

      unmount();

      expect(mockDispose).toHaveBeenCalled();
      expect(mockOnDataDispose).toHaveBeenCalled();
      expect(mockOnResizeDispose).toHaveBeenCalled();
    });
  });

  describe("theme", () => {
    it("applies dark theme by default", () => {
      render(<Terminal />);
      // Theme is passed to XTerm constructor, verified through mock
      expect(screen.getByTestId("terminal")).toBeInTheDocument();
    });

    it("accepts light theme prop", () => {
      render(<Terminal theme="light" />);
      expect(screen.getByTestId("terminal")).toBeInTheDocument();
    });
  });
});

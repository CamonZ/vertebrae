import { useEffect, useRef, useImperativeHandle, forwardRef } from "react";
import { Terminal as XTerm } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";

/**
 * Terminal dimensions in rows and columns
 */
export interface TerminalDimensions {
  cols: number;
  rows: number;
}

/**
 * Theme colors for the terminal, matching the neural-pathways design system
 */
export interface TerminalTheme {
  background: string;
  foreground: string;
  cursor: string;
  cursorAccent: string;
  selectionBackground: string;
  selectionForeground: string;
  black: string;
  red: string;
  green: string;
  yellow: string;
  blue: string;
  magenta: string;
  cyan: string;
  white: string;
  brightBlack: string;
  brightRed: string;
  brightGreen: string;
  brightYellow: string;
  brightBlue: string;
  brightMagenta: string;
  brightCyan: string;
  brightWhite: string;
}

/**
 * Default dark theme matching the neural-pathways design system
 */
const darkTheme: TerminalTheme = {
  background: "#09090b", // --color-bg-primary
  foreground: "#fafaf9", // --color-text-primary
  cursor: "#f59e0b", // --color-primary (amber)
  cursorAccent: "#09090b", // --color-bg-primary
  selectionBackground: "rgba(245, 158, 11, 0.3)", // --color-primary with opacity
  selectionForeground: "#fafaf9",
  // Standard 16 ANSI colors - tuned for readability on dark background
  black: "#09090b",
  red: "#ef4444", // --color-error
  green: "#22c55e", // --color-success
  yellow: "#eab308", // --color-warning
  blue: "#3b82f6",
  magenta: "#a78bfa", // --color-info (violet)
  cyan: "#06b6d4",
  white: "#a8a29e", // --color-text-secondary
  brightBlack: "#57534e", // --color-text-muted
  brightRed: "#f87171",
  brightGreen: "#4ade80",
  brightYellow: "#facc15",
  brightBlue: "#60a5fa",
  brightMagenta: "#c4b5fd",
  brightCyan: "#22d3ee",
  brightWhite: "#fafaf9", // --color-text-primary
};

/**
 * Light theme for users who prefer light mode
 */
const lightTheme: TerminalTheme = {
  background: "#fafaf9", // --color-bg-primary (light)
  foreground: "#1c1917", // --color-text-primary (light)
  cursor: "#f59e0b", // --color-primary (amber)
  cursorAccent: "#fafaf9",
  selectionBackground: "rgba(245, 158, 11, 0.3)",
  selectionForeground: "#1c1917",
  black: "#1c1917",
  red: "#dc2626",
  green: "#16a34a",
  yellow: "#ca8a04",
  blue: "#2563eb",
  magenta: "#7c3aed",
  cyan: "#0891b2",
  white: "#a8a29e",
  brightBlack: "#57534e",
  brightRed: "#ef4444",
  brightGreen: "#22c55e",
  brightYellow: "#eab308",
  brightBlue: "#3b82f6",
  brightMagenta: "#a78bfa",
  brightCyan: "#06b6d4",
  brightWhite: "#fafaf9",
};

export interface TerminalProps {
  /** Callback when user types input */
  onData?: (data: string) => void;
  /** Callback when terminal is resized */
  onResize?: (dimensions: TerminalDimensions) => void;
  /** Custom theme override */
  theme?: "dark" | "light";
  /** Whether terminal should auto-focus on mount */
  autoFocus?: boolean;
  /** Font size in pixels */
  fontSize?: number;
  /** Font family */
  fontFamily?: string;
  /** Additional CSS class names */
  className?: string;
}

export interface TerminalHandle {
  /** Write data to the terminal (PTY output) */
  write: (data: string | Uint8Array) => void;
  /** Clear the terminal screen */
  clear: () => void;
  /** Focus the terminal */
  focus: () => void;
  /** Get current terminal dimensions */
  getDimensions: () => TerminalDimensions;
  /** Resize terminal to fit container */
  fit: () => void;
}

/**
 * Terminal component that renders xterm.js with ANSI escape sequence support.
 * Provides write() method for PTY output and onData callback for user input.
 *
 * Features:
 * - Full ANSI escape sequence rendering (colors, styles, cursor movement)
 * - 256 colors and true color (24-bit) support
 * - Auto-resize to fit container
 * - Theme integration with neural-pathways design system
 * - Keyboard input capture
 */
export const Terminal = forwardRef<TerminalHandle, TerminalProps>(
  function Terminal(
    {
      onData,
      onResize,
      theme = "dark",
      autoFocus = true,
      fontSize = 14,
      fontFamily = '"Geist Mono", "SF Mono", Monaco, monospace',
      className = "",
    },
    ref
  ) {
    const containerRef = useRef<HTMLDivElement>(null);
    const terminalRef = useRef<XTerm | null>(null);
    const fitAddonRef = useRef<FitAddon | null>(null);
    const resizeObserverRef = useRef<ResizeObserver | null>(null);

    // Expose imperative methods
    useImperativeHandle(ref, () => ({
      write: (data: string | Uint8Array) => {
        terminalRef.current?.write(data);
      },
      clear: () => {
        terminalRef.current?.clear();
      },
      focus: () => {
        terminalRef.current?.focus();
      },
      getDimensions: () => {
        const term = terminalRef.current;
        return {
          cols: term?.cols ?? 80,
          rows: term?.rows ?? 24,
        };
      },
      fit: () => {
        fitAddonRef.current?.fit();
      },
    }));

    useEffect(() => {
      if (!containerRef.current) return;

      const selectedTheme = theme === "light" ? lightTheme : darkTheme;

      // Create terminal instance
      const term = new XTerm({
        theme: selectedTheme,
        fontSize,
        fontFamily,
        cursorBlink: true,
        cursorStyle: "block",
        allowProposedApi: true,
        scrollback: 10000,
        convertEol: true,
        // Enable true color support
        allowTransparency: true,
      });

      // Create and load fit addon
      const fitAddon = new FitAddon();
      term.loadAddon(fitAddon);

      // Store refs
      terminalRef.current = term;
      fitAddonRef.current = fitAddon;

      // Open terminal in container
      term.open(containerRef.current);

      // Initial fit
      requestAnimationFrame(() => {
        fitAddon.fit();
        if (autoFocus) {
          term.focus();
        }
        // Notify initial dimensions
        if (onResize) {
          onResize({ cols: term.cols, rows: term.rows });
        }
      });

      // Handle user input
      const dataDisposable = term.onData((data) => {
        onData?.(data);
      });

      // Handle resize events from terminal
      const resizeDisposable = term.onResize((size) => {
        onResize?.({ cols: size.cols, rows: size.rows });
      });

      // Set up container resize observer
      const resizeObserver = new ResizeObserver(() => {
        requestAnimationFrame(() => {
          fitAddon.fit();
        });
      });
      resizeObserver.observe(containerRef.current);
      resizeObserverRef.current = resizeObserver;

      // Cleanup
      return () => {
        dataDisposable.dispose();
        resizeDisposable.dispose();
        resizeObserver.disconnect();
        term.dispose();
        terminalRef.current = null;
        fitAddonRef.current = null;
        resizeObserverRef.current = null;
      };
    }, [theme, fontSize, fontFamily, autoFocus, onData, onResize]);

    return (
      <div
        ref={containerRef}
        className={`terminal-container w-full h-full min-h-0 ${className}`}
        data-testid="terminal"
      />
    );
  }
);

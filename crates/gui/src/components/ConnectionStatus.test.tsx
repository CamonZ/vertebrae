import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import { ConnectionStatus } from "./ConnectionStatus";
import type { WebSocketStatus } from "../hooks/useWebSocketStatus";

let mockStatus: WebSocketStatus = "disconnected";

vi.mock("../hooks/useWebSocketStatus", () => ({
  useWebSocketStatus: () => mockStatus,
}));

describe("ConnectionStatus", () => {
  beforeEach(() => {
    mockStatus = "disconnected";
  });

  it("renders a dot-only indicator with no visible status word", () => {
    mockStatus = "connected";
    render(<ConnectionStatus />);

    const indicator = screen.getByRole("status");
    expect(indicator).toHaveTextContent("");
    expect(screen.queryByText("Connected")).not.toBeInTheDocument();
    expect(indicator).toHaveAccessibleName("WebSocket: Connected");
  });

  it("exposes the full status in the tooltip for each connection state", () => {
    const cases: Array<[WebSocketStatus, string]> = [
      ["connecting", "WebSocket: Connecting"],
      ["reconnecting", "WebSocket: Reconnecting"],
      ["disconnected", "WebSocket: Disconnected"],
    ];

    for (const [status, expected] of cases) {
      mockStatus = status;
      const { unmount } = render(<ConnectionStatus />);
      expect(screen.getByRole("status")).toHaveAccessibleName(expected);
      unmount();
    }
  });

  it("colors the solid dot with design-system tokens (not raw Tailwind palette)", () => {
    const cases: Array<[WebSocketStatus, string]> = [
      ["connected", "bg-[var(--color-ok)]"],
      ["connecting", "bg-[var(--color-warn)]"],
      ["reconnecting", "bg-[var(--color-warn)]"],
      ["disconnected", "bg-[var(--color-err)]"],
    ];

    for (const [status, expectedToken] of cases) {
      mockStatus = status;
      const { unmount } = render(<ConnectionStatus />);
      const solidDot = screen.getByTestId("connection-status-dot");
      expect(solidDot).toHaveClass(expectedToken);
      expect(solidDot?.className).toContain("shadow-[0_0_6px_color-mix(in_oklch,");
      expect(solidDot?.className).not.toMatch(/bg-(green|yellow|red)-\d{3}/);
      unmount();
    }
  });

  it("reuses the solid-dot token for the pulse layer while connecting", () => {
    mockStatus = "connecting";
    const { container } = render(<ConnectionStatus />);
    const pulse = container.querySelector(".animate-ping");
    expect(pulse).not.toBeNull();
    expect(pulse).toHaveClass("bg-[var(--color-warn)]");
  });

  it("pulses only while connecting or reconnecting", () => {
    mockStatus = "connecting";
    const { container, unmount } = render(<ConnectionStatus />);
    expect(container.querySelector(".animate-ping")).not.toBeNull();
    unmount();

    mockStatus = "connected";
    const { container: stable } = render(<ConnectionStatus />);
    expect(stable.querySelector(".animate-ping")).toBeNull();
  });
});

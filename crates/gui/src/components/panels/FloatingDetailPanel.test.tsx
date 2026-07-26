import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { FloatingDetailPanel } from "./FloatingDetailPanel";
import { usePanelFocusStore } from "../../stores/panelFocusStore";
import { usePanelLayoutStore } from "../../stores/panelLayoutStore";

function renderPanel() {
  return render(
    <FloatingDetailPanel
      panelId="test-detail"
      widthStorageKey="test-detail-width"
      onClose={vi.fn()}
      testId="detail-panel"
    >
      detail
    </FloatingDetailPanel>
  );
}

describe("FloatingDetailPanel chat coordination", () => {
  beforeEach(() => {
    Object.defineProperty(window, "innerWidth", {
      configurable: true,
      writable: true,
      value: 1200,
    });
    localStorage.clear();
    usePanelFocusStore.getState().reset();
    usePanelLayoutStore.getState().reset();
  });

  it("reserves the live normal chat width plus the shared panel gap", () => {
    usePanelLayoutStore.getState().setChatLayout({
      isPresent: true,
      renderedWidth: 432,
      isMaximized: false,
    });

    renderPanel();

    const panel = screen.getByTestId("detail-panel");
    expect(panel).toHaveAttribute("data-chat-adjacent", "true");
    expect(panel.style.getPropertyValue("--detail-panel-chat-offset")).toBe(
      "calc(432px + var(--s-3))"
    );
  });

  it("returns to the base right inset beneath maximized chat", () => {
    usePanelLayoutStore.getState().setChatLayout({
      isPresent: true,
      renderedWidth: 900,
      isMaximized: true,
    });

    renderPanel();

    const panel = screen.getByTestId("detail-panel");
    expect(panel).not.toHaveAttribute("data-chat-adjacent");
    expect(panel.style.getPropertyValue("--detail-panel-chat-offset")).toBe(
      "0px"
    );
  });

  it("overlays instead of collapsing when adjacent space is below the minimum", () => {
    window.innerWidth = 800;
    usePanelLayoutStore.getState().setChatLayout({
      isPresent: true,
      renderedWidth: 760,
      isMaximized: false,
    });

    renderPanel();

    const panel = screen.getByTestId("detail-panel");
    expect(panel).not.toHaveAttribute("data-chat-adjacent");
    expect(panel.style.getPropertyValue("--detail-panel-chat-offset")).toBe(
      "0px"
    );
  });

  it("switches to overlay mode when a viewport resize removes adjacent space", () => {
    usePanelLayoutStore.getState().setChatLayout({
      isPresent: true,
      renderedWidth: 432,
      isMaximized: false,
    });

    renderPanel();
    const panel = screen.getByTestId("detail-panel");
    expect(panel).toHaveAttribute("data-chat-adjacent", "true");

    window.innerWidth = 700;
    fireEvent(window, new Event("resize"));

    expect(panel).not.toHaveAttribute("data-chat-adjacent");
    expect(panel.style.getPropertyValue("--detail-panel-chat-offset")).toBe(
      "0px"
    );
  });

});

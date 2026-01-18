import { describe, it, expect, beforeEach } from "vitest";
import { useUIStore } from "./uiStore";

describe("uiStore", () => {
  beforeEach(() => {
    // Reset store state before each test
    useUIStore.setState({
      theme: "system",
      chatPanelOpen: false,
      chatPanelWidth: 480,
    });
  });

  describe("initial state", () => {
    it("has system theme by default", () => {
      const state = useUIStore.getState();
      expect(state.theme).toBe("system");
    });

    it("has chat panel closed by default", () => {
      const state = useUIStore.getState();
      expect(state.chatPanelOpen).toBe(false);
    });

    it("has default chat panel width", () => {
      const state = useUIStore.getState();
      expect(state.chatPanelWidth).toBe(480);
    });
  });

  describe("setTheme", () => {
    it("sets theme to light", () => {
      useUIStore.getState().setTheme("light");

      expect(useUIStore.getState().theme).toBe("light");
    });

    it("sets theme to dark", () => {
      useUIStore.getState().setTheme("dark");

      expect(useUIStore.getState().theme).toBe("dark");
    });

    it("sets theme to system", () => {
      useUIStore.setState({ theme: "dark" });

      useUIStore.getState().setTheme("system");

      expect(useUIStore.getState().theme).toBe("system");
    });
  });

  describe("toggleChatPanel", () => {
    it("opens chat panel when closed", () => {
      useUIStore.getState().toggleChatPanel();

      expect(useUIStore.getState().chatPanelOpen).toBe(true);
    });

    it("closes chat panel when open", () => {
      useUIStore.setState({ chatPanelOpen: true });

      useUIStore.getState().toggleChatPanel();

      expect(useUIStore.getState().chatPanelOpen).toBe(false);
    });

    it("toggles multiple times correctly", () => {
      useUIStore.getState().toggleChatPanel();
      expect(useUIStore.getState().chatPanelOpen).toBe(true);

      useUIStore.getState().toggleChatPanel();
      expect(useUIStore.getState().chatPanelOpen).toBe(false);

      useUIStore.getState().toggleChatPanel();
      expect(useUIStore.getState().chatPanelOpen).toBe(true);
    });
  });

  describe("setChatPanelOpen", () => {
    it("sets chat panel to open", () => {
      useUIStore.getState().setChatPanelOpen(true);

      expect(useUIStore.getState().chatPanelOpen).toBe(true);
    });

    it("sets chat panel to closed", () => {
      useUIStore.setState({ chatPanelOpen: true });

      useUIStore.getState().setChatPanelOpen(false);

      expect(useUIStore.getState().chatPanelOpen).toBe(false);
    });
  });

  describe("setChatPanelWidth", () => {
    it("sets chat panel width", () => {
      useUIStore.getState().setChatPanelWidth(600);

      expect(useUIStore.getState().chatPanelWidth).toBe(600);
    });

    it("allows setting width to minimum", () => {
      useUIStore.getState().setChatPanelWidth(300);

      expect(useUIStore.getState().chatPanelWidth).toBe(300);
    });
  });
});

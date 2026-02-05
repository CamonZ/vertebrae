import { describe, it, expect, beforeEach } from "vitest";
import { useUIStore } from "./uiStore";

describe("uiStore", () => {
  beforeEach(() => {
    // Reset store state before each test
    useUIStore.setState({
      theme: "system",
      claudeSidebarOpen: false,
    });
  });

  describe("initial state", () => {
    it("has system theme by default", () => {
      const state = useUIStore.getState();
      expect(state.theme).toBe("system");
    });

    it("has Claude sidebar closed by default", () => {
      const state = useUIStore.getState();
      expect(state.claudeSidebarOpen).toBe(false);
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

  describe("toggleClaudeSidebar", () => {
    it("opens Claude sidebar when closed", () => {
      useUIStore.getState().toggleClaudeSidebar();

      expect(useUIStore.getState().claudeSidebarOpen).toBe(true);
    });

    it("closes Claude sidebar when open", () => {
      useUIStore.setState({ claudeSidebarOpen: true });

      useUIStore.getState().toggleClaudeSidebar();

      expect(useUIStore.getState().claudeSidebarOpen).toBe(false);
    });

    it("toggles multiple times correctly", () => {
      useUIStore.getState().toggleClaudeSidebar();
      expect(useUIStore.getState().claudeSidebarOpen).toBe(true);

      useUIStore.getState().toggleClaudeSidebar();
      expect(useUIStore.getState().claudeSidebarOpen).toBe(false);

      useUIStore.getState().toggleClaudeSidebar();
      expect(useUIStore.getState().claudeSidebarOpen).toBe(true);
    });
  });

  describe("setClaudeSidebarOpen", () => {
    it("sets Claude sidebar to open", () => {
      useUIStore.getState().setClaudeSidebarOpen(true);

      expect(useUIStore.getState().claudeSidebarOpen).toBe(true);
    });

    it("sets Claude sidebar to closed", () => {
      useUIStore.setState({ claudeSidebarOpen: true });

      useUIStore.getState().setClaudeSidebarOpen(false);

      expect(useUIStore.getState().claudeSidebarOpen).toBe(false);
    });
  });
});

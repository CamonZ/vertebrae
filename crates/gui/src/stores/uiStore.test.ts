import { describe, it, expect, beforeEach } from "vitest";
import { useUIStore } from "./uiStore";

describe("uiStore", () => {
  beforeEach(() => {
    // Reset store state before each test
    useUIStore.setState({
      sidebarCollapsed: false,
      theme: "system",
    });
  });

  describe("initial state", () => {
    it("has sidebar expanded by default", () => {
      const state = useUIStore.getState();
      expect(state.sidebarCollapsed).toBe(false);
    });

    it("has system theme by default", () => {
      const state = useUIStore.getState();
      expect(state.theme).toBe("system");
    });
  });

  describe("toggleSidebar", () => {
    it("collapses sidebar when expanded", () => {
      useUIStore.getState().toggleSidebar();

      expect(useUIStore.getState().sidebarCollapsed).toBe(true);
    });

    it("expands sidebar when collapsed", () => {
      useUIStore.setState({ sidebarCollapsed: true });

      useUIStore.getState().toggleSidebar();

      expect(useUIStore.getState().sidebarCollapsed).toBe(false);
    });

    it("toggles multiple times correctly", () => {
      useUIStore.getState().toggleSidebar();
      expect(useUIStore.getState().sidebarCollapsed).toBe(true);

      useUIStore.getState().toggleSidebar();
      expect(useUIStore.getState().sidebarCollapsed).toBe(false);

      useUIStore.getState().toggleSidebar();
      expect(useUIStore.getState().sidebarCollapsed).toBe(true);
    });
  });

  describe("setSidebarCollapsed", () => {
    it("sets sidebar to collapsed", () => {
      useUIStore.getState().setSidebarCollapsed(true);

      expect(useUIStore.getState().sidebarCollapsed).toBe(true);
    });

    it("sets sidebar to expanded", () => {
      useUIStore.setState({ sidebarCollapsed: true });

      useUIStore.getState().setSidebarCollapsed(false);

      expect(useUIStore.getState().sidebarCollapsed).toBe(false);
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
});

import { describe, it, expect, beforeEach, vi } from "vitest";
import { useUIStore } from "./uiStore";

describe("uiStore", () => {
  beforeEach(() => {
    // Reset store state before each test
    useUIStore.setState({
      theme: "system",
    });
  });

  describe("initial state", () => {
    it("has system theme by default", () => {
      const state = useUIStore.getState();
      expect(state.theme).toBe("system");
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

  describe("persistence", () => {
    it("partializes theme into persisted state", () => {
      const setItemSpy = vi.spyOn(Storage.prototype, "setItem");

      useUIStore.getState().setTheme("dark");

      const persistCall = setItemSpy.mock.calls.find(
        ([key]) => key === "vertebrae-ui-storage"
      );
      expect(persistCall).toBeDefined();
      const persisted = JSON.parse(persistCall![1]);
      expect(persisted.state).toEqual({ theme: "dark" });

      setItemSpy.mockRestore();
    });
  });
});

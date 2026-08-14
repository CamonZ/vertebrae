import { describe, it, expect, beforeEach, vi } from "vitest";
import { useUIStore } from "./uiStore";

describe("uiStore", () => {
  beforeEach(() => {
    // Reset store state before each test
    useUIStore.setState({
      theme: "system",
      density: "auto",
      externalEditor: "",
    });
  });

  describe("initial state", () => {
    it("has system theme by default", () => {
      const state = useUIStore.getState();
      expect(state.theme).toBe("system");
    });

    it("has auto density by default", () => {
      const state = useUIStore.getState();
      expect(state.density).toBe("auto");
    });

    it("uses the operating system default editor by default", () => {
      const state = useUIStore.getState();
      expect(state.externalEditor).toBe("");
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

  describe("setDensity", () => {
    it("sets density to comfortable", () => {
      useUIStore.getState().setDensity("comfortable");

      expect(useUIStore.getState().density).toBe("comfortable");
    });

    it("sets density to compact", () => {
      useUIStore.getState().setDensity("compact");

      expect(useUIStore.getState().density).toBe("compact");
    });

    it("sets density to default", () => {
      useUIStore.setState({ density: "comfortable" });

      useUIStore.getState().setDensity("default");

      expect(useUIStore.getState().density).toBe("default");
    });

    it("sets density to auto", () => {
      useUIStore.setState({ density: "compact" });

      useUIStore.getState().setDensity("auto");

      expect(useUIStore.getState().density).toBe("auto");
    });
  });

  describe("setExternalEditor", () => {
    it("stores the configured application name or path", () => {
      useUIStore.getState().setExternalEditor("app:/Applications/Visual Studio Code.app");

      expect(useUIStore.getState().externalEditor).toBe(
        "app:/Applications/Visual Studio Code.app"
      );
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
      expect(persisted.state).toEqual({
        theme: "dark",
        density: "auto",
        externalEditor: "",
      });

      setItemSpy.mockRestore();
    });
  });
});

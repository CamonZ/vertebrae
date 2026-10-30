import { describe, it, expect, beforeEach, vi } from "vitest";
import { useUIStore } from "./uiStore";
import { DEFAULT_DIFF_PREFERENCES } from "../utils/codeAppearance";

describe("uiStore", () => {
  beforeEach(() => {
    // Reset store state before each test
    useUIStore.setState({
      theme: "system",
      thinkingIndicatorStyle: "classic",
      density: "auto",
      externalEditor: "",
      codeThemeDark: "pierre-dark",
      codeThemeLight: "pierre-light",
      diffPreferences: DEFAULT_DIFF_PREFERENCES,
      inlineCodeForeground: null,
      inlineCodeBackground: null,
    });
  });

  describe("initial state", () => {
    it("has system theme by default", () => {
      const state = useUIStore.getState();
      expect(state.theme).toBe("system");
    });

    it("uses the classic thinking indicator by default", () => {
      const state = useUIStore.getState();
      expect(state.thinkingIndicatorStyle).toBe("classic");
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

  describe("setThinkingIndicatorStyle", () => {
    it("sets the futuristic style", () => {
      useUIStore.getState().setThinkingIndicatorStyle("futuristic");

      expect(useUIStore.getState().thinkingIndicatorStyle).toBe("futuristic");
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
      useUIStore
        .getState()
        .setExternalEditor("app:/Applications/Visual Studio Code.app");

      expect(useUIStore.getState().externalEditor).toBe(
        "app:/Applications/Visual Studio Code.app"
      );
    });
  });

  describe("persistence", () => {
    it("partializes thinking indicator style into persisted state", () => {
      const setItemSpy = vi.spyOn(Storage.prototype, "setItem");

      useUIStore.getState().setThinkingIndicatorStyle("futuristic");

      const persistCall = setItemSpy.mock.calls.find(
        ([key]) => key === "vertebrae-ui-storage"
      );
      expect(persistCall).toBeDefined();
      const persisted = JSON.parse(persistCall![1]);
      expect(persisted.state).toEqual({
        theme: "system",
        thinkingIndicatorStyle: "futuristic",
        density: "auto",
        externalEditor: "",
        gateSteeringThresholds: { soft: 3, form: 6, escape: 9 },
        codeThemeDark: "pierre-dark",
        codeThemeLight: "pierre-light",
        diffPreferences: DEFAULT_DIFF_PREFERENCES,
        inlineCodeForeground: null,
        inlineCodeBackground: null,
      });

      setItemSpy.mockRestore();
    });

    it("persists code appearance preferences", () => {
      const setItemSpy = vi.spyOn(Storage.prototype, "setItem");

      useUIStore.getState().setCodeTheme("dark", "tokyo-night");
      useUIStore.getState().setCodeTheme("light", "github-light");
      useUIStore.getState().setDiffPreferences({ diffStyle: "split" });
      useUIStore.getState().setInlineCodeForeground("info");
      useUIStore.getState().setInlineCodeBackground("bg-2");

      const persistCalls = setItemSpy.mock.calls.filter(
        ([key]) => key === "vertebrae-ui-storage"
      );
      const persisted = JSON.parse(persistCalls[persistCalls.length - 1][1]);
      expect(persisted.state).toMatchObject({
        codeThemeDark: "tokyo-night",
        codeThemeLight: "github-light",
        diffPreferences: { ...DEFAULT_DIFF_PREFERENCES, diffStyle: "split" },
        inlineCodeForeground: "info",
        inlineCodeBackground: "bg-2",
      });

      setItemSpy.mockRestore();
    });

    it("keeps code appearance defaults when rehydrating older settings", async () => {
      localStorage.setItem(
        "vertebrae-ui-storage",
        JSON.stringify({
          state: { theme: "dark", thinkingIndicatorStyle: "classic" },
          version: 0,
        })
      );

      await useUIStore.persist.rehydrate();

      const state = useUIStore.getState();
      expect(state.theme).toBe("dark");
      expect(state.codeThemeDark).toBe("pierre-dark");
      expect(state.codeThemeLight).toBe("pierre-light");
      expect(state.diffPreferences).toEqual(DEFAULT_DIFF_PREFERENCES);
      expect(state.inlineCodeForeground).toBeNull();
      expect(state.inlineCodeBackground).toBeNull();
      localStorage.removeItem("vertebrae-ui-storage");
    });

    it("repairs partial or invalid stored diff preferences", async () => {
      localStorage.setItem(
        "vertebrae-ui-storage",
        JSON.stringify({
          state: { diffPreferences: { diffStyle: "split", overflow: "bogus" } },
          version: 0,
        })
      );

      await useUIStore.persist.rehydrate();

      expect(useUIStore.getState().diffPreferences).toEqual({
        ...DEFAULT_DIFF_PREFERENCES,
        diffStyle: "split",
      });
      localStorage.removeItem("vertebrae-ui-storage");
    });
  });

  describe("code appearance", () => {
    it("defaults to the Pierre themes and Hearth inline styling", () => {
      const state = useUIStore.getState();
      expect(state.codeThemeDark).toBe("pierre-dark");
      expect(state.codeThemeLight).toBe("pierre-light");
      expect(state.inlineCodeForeground).toBeNull();
      expect(state.inlineCodeBackground).toBeNull();
    });

    it("resets inline code styling to the Hearth default", () => {
      useUIStore.getState().setInlineCodeForeground("err");
      useUIStore.getState().setInlineCodeBackground("none");
      useUIStore.getState().setCodeTheme("dark", "nord");

      useUIStore.getState().resetInlineCodeStyle();

      const state = useUIStore.getState();
      expect(state.inlineCodeForeground).toBeNull();
      expect(state.inlineCodeBackground).toBeNull();
      expect(state.codeThemeDark).toBe("nord");
    });

    it("sets dark and light themes independently", () => {
      useUIStore.getState().setCodeTheme("light", "one-light");
      expect(useUIStore.getState().codeThemeDark).toBe("pierre-dark");
      expect(useUIStore.getState().codeThemeLight).toBe("one-light");
    });

    it("merges and resets diff preferences", () => {
      useUIStore.getState().setDiffPreferences({ diffStyle: "split" });
      useUIStore.getState().setDiffPreferences({ lineNumbers: false });
      expect(useUIStore.getState().diffPreferences).toEqual({
        ...DEFAULT_DIFF_PREFERENCES,
        diffStyle: "split",
        lineNumbers: false,
      });

      useUIStore.getState().resetDiffPreferences();
      expect(useUIStore.getState().diffPreferences).toEqual(
        DEFAULT_DIFF_PREFERENCES
      );
    });
  });
});

import { describe, it, expect, beforeEach, vi } from "vitest";
import { migrateUIPreferences, useUIStore } from "./uiStore";
import { DEFAULT_DIFF_PREFERENCES } from "../utils/codeAppearance";

describe("uiStore", () => {
  beforeEach(() => {
    // Reset store state before each test
    useUIStore.setState({
      inlineDiscussionPreference: { mode: "follow" },
      theme: "system",
      thinkingIndicatorStyle: "shimmer",
      textSize: "default",
      customTypefaces: {},
      useCustomTypeface: false,
      customTypefaceBase: null,
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

    it("uses the shimmer thinking indicator by default", () => {
      const state = useUIStore.getState();
      expect(state.thinkingIndicatorStyle).toBe("shimmer");
    });

    it("uses the default text size by default", () => {
      expect(useUIStore.getState().textSize).toBe("default");
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
    it.each(["shimmer", "uplink", "assembler"] as const)(
      "sets the %s style",
      (style) => {
        useUIStore.getState().setThinkingIndicatorStyle(style);

        expect(useUIStore.getState().thinkingIndicatorStyle).toBe(style);
      }
    );

    it.each(["classic", "futuristic", undefined])(
      "rehydrates the retired %s style as shimmer",
      async (stored) => {
        useUIStore.setState({ thinkingIndicatorStyle: "uplink" });
        localStorage.setItem(
          "vertebrae-ui-storage",
          JSON.stringify({
            state: { thinkingIndicatorStyle: stored },
            version: 0,
          })
        );

        await useUIStore.persist.rehydrate();

        expect(useUIStore.getState().thinkingIndicatorStyle).toBe("shimmer");
      }
    );

    it("keeps a stored line style on rehydrate", async () => {
      localStorage.setItem(
        "vertebrae-ui-storage",
        JSON.stringify({
          state: { thinkingIndicatorStyle: "assembler" },
          version: 0,
        })
      );

      await useUIStore.persist.rehydrate();

      expect(useUIStore.getState().thinkingIndicatorStyle).toBe("assembler");
    });
  });

  describe("setTextSize", () => {
    it("stores presets and in-range percentages", () => {
      useUIStore.getState().setTextSize("large");
      expect(useUIStore.getState().textSize).toBe("large");

      useUIStore.getState().setTextSize(112);
      expect(useUIStore.getState().textSize).toBe(112);
    });

    it("falls back to the default for out-of-range values", () => {
      useUIStore.getState().setTextSize(400);
      expect(useUIStore.getState().textSize).toBe("default");
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
    it("rehydrates text size independently of typeface", async () => {
      useUIStore.getState().setTextSize("extra-large");
      useUIStore.getState().setTypePairing("technical");
      await useUIStore.persist.rehydrate();

      expect(useUIStore.getState()).toMatchObject({
        textSize: "extra-large",
        typePairing: "technical",
      });

      localStorage.setItem(
        "vertebrae-ui-storage",
        JSON.stringify({ state: { typePairing: "editorial" }, version: 1 })
      );
      await useUIStore.persist.rehydrate();
      expect(useUIStore.getState().textSize).toBe("default");
    });

    it("resets a corrupt stored text size to the default", async () => {
      localStorage.setItem(
        "vertebrae-ui-storage",
        JSON.stringify({ state: { textSize: "huge" }, version: 1 })
      );
      await useUIStore.persist.rehydrate();
      expect(useUIStore.getState().textSize).toBe("default");
    });

    it("migrates a version 0 reading size and drops density", async () => {
      localStorage.setItem(
        "vertebrae-ui-storage",
        JSON.stringify({
          state: { readingTextSize: 112, density: "compact", customTypefaces: { prose: " Georgia ", mono: 42 } },
          version: 0,
        })
      );
      await useUIStore.persist.rehydrate();
      expect(useUIStore.getState()).toMatchObject({
        textSize: 112,
        customTypefaces: { prose: "Georgia" },
        useCustomTypeface: true,
      });
      expect(useUIStore.getState()).not.toHaveProperty("readingTextSize");
      expect(useUIStore.getState()).not.toHaveProperty("density");
      expect(useUIStore.getState().customTypefaces.mono).toBeUndefined();
    });

    it("partializes thinking indicator style into persisted state", () => {
      const setItemSpy = vi.spyOn(Storage.prototype, "setItem");

      useUIStore.getState().setThinkingIndicatorStyle("uplink");

      const persistCall = setItemSpy.mock.calls.find(
        ([key]) => key === "vertebrae-ui-storage"
      );
      expect(persistCall).toBeDefined();
      const persisted = JSON.parse(persistCall![1]);
      expect(persisted.state).toEqual({
        inlineDiscussionPreference: { mode: "follow" },
        theme: "system",
        typePairing: "editorial",
        accent: "orchid",
        thinkingIndicatorStyle: "uplink",
        textSize: "default",
        customTypefaces: {},
        useCustomTypeface: false,
        customTypefaceBase: null,
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

it("persists and rehydrates inline discussion choice without changing main chat defaults", async () => {
  const dedicated = {
    mode: "dedicated" as const,
    providerId: "custom",
    modelId: "dedicated",
  };
  const initialState = useUIStore.getState();

  initialState.setInlineDiscussionPreference(dedicated);

  const saved = localStorage.getItem("vertebrae-ui-storage")!;
  const savedState = JSON.parse(saved).state;

  expect(savedState.inlineDiscussionPreference).toEqual(dedicated);

  useUIStore.setState({ inlineDiscussionPreference: { mode: "follow" } });
  localStorage.setItem("vertebrae-ui-storage", saved);
  await useUIStore.persist.rehydrate();

  const restoredState = useUIStore.getState();

  expect(restoredState.inlineDiscussionPreference).toEqual(dedicated);

  const malformedState = {
    state: {
      inlineDiscussionPreference: { mode: "dedicated", providerId: "custom" },
    },
    version: 0,
  };
  const malformedStorage = JSON.stringify(malformedState);

  localStorage.setItem("vertebrae-ui-storage", malformedStorage);
  await useUIStore.persist.rehydrate();

  const invalidState = useUIStore.getState();

  expect(invalidState.inlineDiscussionPreference).toEqual({ mode: "invalid" });

  const legacyStorage = JSON.stringify({
    state: { theme: "dark" },
    version: 0,
  });

  localStorage.setItem("vertebrae-ui-storage", legacyStorage);
  await useUIStore.persist.rehydrate();

  const legacyState = useUIStore.getState();

  expect(legacyState.inlineDiscussionPreference).toEqual({ mode: "follow" });
});

describe("migrateUIPreferences", () => {
  it.each([
    [{ readingTextSize: "larger", density: "compact" }, "larger"],
    [{ readingTextSize: "small", density: "auto" }, 95],
    [{ readingTextSize: 140 }, 140],
    [{ readingTextSize: "default", density: "comfortable" }, "medium"],
    [{ readingTextSize: "default", density: "compact" }, "small"],
    [{ density: "default" }, "default"],
    [{ density: "auto" }, "default"],
    [{ readingTextSize: "constructor", density: 7 }, "default"],
    [{}, "default"],
  ])("maps %j to text size %j", (legacy, textSize) => {
    expect(migrateUIPreferences({ theme: "dark", ...legacy }, 0)).toEqual({
      theme: "dark",
      textSize,
    });
  });

  it("leaves current and unreadable state alone", () => {
    const current = { textSize: "large", density: "compact" };
    expect(migrateUIPreferences(current, 1)).toBe(current);
    expect(migrateUIPreferences(null, 0)).toBeNull();
  });
});

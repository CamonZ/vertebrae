import { afterEach, describe, expect, it, vi } from "vitest";

const pool = vi.hoisted(() => ({
  setRenderOptions: vi.fn(() => Promise.resolve()),
  initialize: vi.fn(() => Promise.resolve()),
}));
const createPool = vi.hoisted(() => vi.fn(() => pool));

vi.mock("@pierre/diffs/worker", () => ({
  getOrCreateWorkerPoolSingleton: createPool,
}));

async function loadPool(
  codeThemeDark: string,
  codeThemeLight = "pierre-light"
) {
  vi.resetModules();
  vi.stubGlobal("Worker", class {});
  const { useUIStore } = await import("../../../stores/uiStore");
  useUIStore.setState({ codeThemeDark, codeThemeLight });
  await import("./diffWorkerPool");
  return useUIStore;
}

describe("diffWorkerPool", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    createPool.mockClear();
    pool.setRenderOptions.mockClear();
  });

  it("initializes workers with the shared theme and highlighter", async () => {
    await loadPool("catppuccin-mocha", "catppuccin-latte");

    expect(createPool).toHaveBeenCalledWith(
      expect.objectContaining({
        highlighterOptions: {
          preferredHighlighter: "highlights",
          theme: { dark: "catppuccin-mocha", light: "catppuccin-latte" },
          lineDiffType: "word-alt",
        },
      })
    );
  });

  it("pushes theme changes to the pool and its workers", async () => {
    const useUIStore = await loadPool("pierre-dark");

    useUIStore.getState().setCodeTheme("light", "solarized-light");
    expect(pool.setRenderOptions).toHaveBeenLastCalledWith({
      theme: { dark: "pierre-dark", light: "solarized-light" },
      lineDiffType: "word-alt",
    });

    useUIStore.getState().setDiffPreferences({ lineDiffType: "char" });
    expect(pool.setRenderOptions).toHaveBeenLastCalledWith({
      theme: { dark: "pierre-dark", light: "solarized-light" },
      lineDiffType: "char",
    });

    pool.setRenderOptions.mockClear();
    useUIStore.getState().setInlineCodeForeground("info");
    useUIStore.getState().setTheme("light");
    useUIStore.getState().setDiffPreferences({ diffStyle: "split" });
    expect(pool.setRenderOptions).not.toHaveBeenCalled();
  });
});

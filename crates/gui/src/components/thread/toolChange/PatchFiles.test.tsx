import { act, render } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useUIStore } from "../../../stores/uiStore";
import { DEFAULT_DIFF_PREFERENCES } from "../../../utils/codeAppearance";
import PatchFiles from "./PatchFiles";

const diffOptions = vi.hoisted(() => [] as Array<Record<string, unknown>>);

vi.mock("@pierre/diffs/react", async () => {
  const { createContext } = await import("react");
  return {
    WorkerPoolContext: createContext(undefined),
    FileDiff: ({ options }: { options: Record<string, unknown> }) => {
      diffOptions.push(options);
      return <div data-testid="patch-diff" />;
    },
  };
});

const PATCH = "diff --git a/a b/a\n--- a/a\n+++ b/a\n@@ -1 +1 @@\n-x\n+y\n";

describe("PatchFiles", () => {
  beforeEach(() => {
    diffOptions.length = 0;
    useUIStore.setState({
      theme: "dark",
      codeThemeDark: "pierre-dark",
      codeThemeLight: "pierre-light",
      diffPreferences: DEFAULT_DIFF_PREFERENCES,
    });
  });

  it("renders diffs with the shared theme through Highlights", () => {
    render(<PatchFiles patch={PATCH} />);

    expect(diffOptions[diffOptions.length - 1]).toEqual({
      theme: { dark: "pierre-dark", light: "pierre-light" },
      themeType: "dark",
      preferredHighlighter: "highlights",
      diffStyle: "unified",
      diffIndicators: "bars",
      lineDiffType: "word-alt",
      overflow: "scroll",
      hunkSeparators: "line-info",
      disableLineNumbers: false,
      disableBackground: false,
    });
  });

  it("updates theme and mode without a restart", () => {
    render(<PatchFiles patch={PATCH} />);

    act(() =>
      useUIStore.setState({
        codeThemeDark: "one-dark-pro",
        codeThemeLight: "one-light",
        theme: "light",
      })
    );

    expect(diffOptions[diffOptions.length - 1]).toMatchObject({
      theme: { dark: "one-dark-pro", light: "one-light" },
      themeType: "light",
    });
  });

  it("applies the diff preferences", () => {
    render(<PatchFiles patch={PATCH} />);

    act(() =>
      useUIStore.getState().setDiffPreferences({
        diffStyle: "split",
        diffIndicators: "classic",
        overflow: "wrap",
        hunkSeparators: "simple",
        lineNumbers: false,
        backgrounds: false,
      })
    );

    expect(diffOptions[diffOptions.length - 1]).toMatchObject({
      diffStyle: "split",
      diffIndicators: "classic",
      overflow: "wrap",
      hunkSeparators: "simple",
      disableLineNumbers: true,
      disableBackground: true,
    });
  });
});

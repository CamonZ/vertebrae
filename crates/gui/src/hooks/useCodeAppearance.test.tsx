import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useUIStore } from "../stores/uiStore";
import {
  FALLBACK_SELECTION_BG,
  pierreSelectionCSS,
} from "../utils/codeAppearance";
import { useInlineCodeStyle, usePierreThemeOptions } from "./useCodeAppearance";

const THEME_COLORS: Record<string, Record<string, string>> = {
  "pierre-dark": { "editor.selectionBackground": "#009fff4d" },
  "github-dark-default": {},
};

vi.mock("@pierre/diffs", () => ({
  getResolvedOrResolveTheme: (name: string) =>
    Promise.resolve({ name, colors: THEME_COLORS[name] }),
}));

describe("useInlineCodeStyle", () => {
  const style = document.documentElement.style;

  beforeEach(() => {
    useUIStore.setState({
      inlineCodeForeground: null,
      inlineCodeBackground: null,
    });
  });

  afterEach(() => {
    style.removeProperty("--inline-code-fg");
    style.removeProperty("--inline-code-bg");
  });

  it("leaves the Hearth defaults from index.css in place", () => {
    renderHook(() => useInlineCodeStyle());
    expect(style.getPropertyValue("--inline-code-fg")).toBe("");
    expect(style.getPropertyValue("--inline-code-bg")).toBe("");
  });

  it("applies and resets the selected colors on the root", () => {
    renderHook(() => useInlineCodeStyle());

    act(() => {
      useUIStore.getState().setInlineCodeForeground("ok");
      useUIStore.getState().setInlineCodeBackground("none");
    });
    expect(style.getPropertyValue("--inline-code-fg")).toBe("var(--color-ok)");
    expect(style.getPropertyValue("--inline-code-bg")).toBe("transparent");

    act(() => useUIStore.getState().resetInlineCodeStyle());
    expect(style.getPropertyValue("--inline-code-fg")).toBe("");
    expect(style.getPropertyValue("--inline-code-bg")).toBe("");
  });

  it("ignores unavailable stored colors", () => {
    useUIStore.setState({ inlineCodeForeground: "removed" });
    renderHook(() => useInlineCodeStyle());
    expect(style.getPropertyValue("--inline-code-fg")).toBe("");
  });
});

describe("usePierreThemeOptions", () => {
  it("uses the selection colour the theme defines", async () => {
    useUIStore.setState({ theme: "dark", codeThemeDark: "pierre-dark" });
    const { result } = renderHook(() => usePierreThemeOptions());

    await waitFor(() =>
      expect(result.current.unsafeCSS).toBe(pierreSelectionCSS("#009fff4d"))
    );
  });

  it("falls back to a foreground mix for themes without one", async () => {
    useUIStore.setState({
      theme: "dark",
      codeThemeDark: "github-dark-default",
    });
    const { result } = renderHook(() => usePierreThemeOptions());

    await act(() => Promise.resolve());
    expect(result.current.unsafeCSS).toBe(pierreSelectionCSS(null));
    expect(result.current.unsafeCSS).toContain(FALLBACK_SELECTION_BG);
  });
});

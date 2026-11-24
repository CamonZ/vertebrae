import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { ACCENTS } from "./accents";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  CODE_THEMES,
  DEFAULT_DIFF_PREFERENCES,
  INLINE_CODE_FOREGROUNDS,
  codeThemePair,
  codeThemesFor,
  inlineCodeColorValue,
  resolveCodeTheme,
  resolveDiffPreferences,
  supportsHighlights,
} from "./codeAppearance";

describe("codeAppearance", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("lists every bundled theme once with both appearances", () => {
    expect(CODE_THEMES).toHaveLength(75);
    expect(new Set(CODE_THEMES.map((theme) => theme.name)).size).toBe(75);
    expect(CODE_THEMES.some((theme) => theme.scheme === "dark")).toBe(true);
    expect(CODE_THEMES.some((theme) => theme.scheme === "light")).toBe(true);
  });

  it("falls back per appearance for unknown stored themes", () => {
    expect(resolveCodeTheme("gone", "dark")).toBe("pierre-dark");
    expect(resolveCodeTheme(undefined, "light")).toBe("pierre-light");
    expect(codeThemePair("gone", "one-light")).toEqual({
      dark: "pierre-dark",
      light: "one-light",
    });
  });

  it("rejects themes designed for the other appearance", () => {
    expect(codeThemePair("github-light", "nord")).toEqual({
      dark: "pierre-dark",
      light: "pierre-light",
    });
  });

  it("lists themes per appearance", () => {
    expect(codeThemesFor("dark")).toHaveLength(49);
    expect(codeThemesFor("light")).toHaveLength(26);
    expect(codeThemesFor("light").every((t) => t.scheme === "light")).toBe(
      true
    );
  });

  it("returns a stable theme pair per combination", () => {
    expect(codeThemePair("nord", "one-light")).toBe(
      codeThemePair("nord", "one-light")
    );
  });

  it("repairs stored diff preferences", () => {
    expect(resolveDiffPreferences(undefined)).toEqual(DEFAULT_DIFF_PREFERENCES);
    expect(
      resolveDiffPreferences({
        diffStyle: "split",
        lineDiffType: "bogus",
        lineNumbers: "no",
        backgrounds: false,
        extra: 1,
      })
    ).toEqual({
      ...DEFAULT_DIFF_PREFERENCES,
      diffStyle: "split",
      backgrounds: false,
    });
  });

  it("uses the Hearth default for unset or unknown inline colors", () => {
    expect(inlineCodeColorValue(INLINE_CODE_FOREGROUNDS, null)).toBeNull();
    expect(inlineCodeColorValue(INLINE_CODE_FOREGROUNDS, "gone")).toBeNull();
    expect(inlineCodeColorValue(INLINE_CODE_FOREGROUNDS, "info")).toBe(
      "var(--color-info)"
    );
  });

  it("offers every accent as a fixed inline color", () => {
    for (const accent of ACCENTS) {
      expect(
        inlineCodeColorValue(INLINE_CODE_FOREGROUNDS, `accent-${accent.value}`)
      ).toBe(`var(--accent-${accent.value})`);
    }
  });

  it("declares a fixed token for every accent in each theme", () => {
    const css = readFileSync(resolve(__dirname, "../styles/tokens.css"), "utf8");
    const fixed = css.slice(css.indexOf("Fixed accent colours"));
    for (const accent of ACCENTS) {
      expect(fixed.match(new RegExp(`--accent-${accent.value}:`, "g"))).toHaveLength(4);
    }
  });

  it("detects WebAssembly SIMD for Highlights", () => {
    expect(supportsHighlights()).toBe(true);
  });

  it("falls back when WebAssembly SIMD is unavailable", () => {
    vi.stubGlobal("WebAssembly", {
      ...WebAssembly,
      validate: () => false,
    });
    expect(supportsHighlights()).toBe(false);

    vi.stubGlobal("WebAssembly", undefined);
    expect(supportsHighlights()).toBe(false);
  });

  it("selects Shiki JS for every surface without SIMD", async () => {
    vi.resetModules();
    vi.stubGlobal("WebAssembly", { validate: () => false });
    const { CODE_HIGHLIGHTER } = await import("./codeAppearance");
    expect(CODE_HIGHLIGHTER).toBe("shiki-js");
  });
});

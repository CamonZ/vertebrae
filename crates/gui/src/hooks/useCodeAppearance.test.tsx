import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { useUIStore } from "../stores/uiStore";
import { useInlineCodeStyle } from "./useCodeAppearance";

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

import { act, render } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useUIStore } from "../../stores/uiStore";
import CodeSnippet from "./CodeSnippet";

const fileProps = vi.hoisted(() => [] as Array<Record<string, unknown>>);

vi.mock("@pierre/diffs/react", async () => {
  const { createContext } = await import("react");
  return {
    WorkerPoolContext: createContext(undefined),
    File: (props: Record<string, unknown>) => {
      fileProps.push(props);
      return <div data-testid="pierre-file" />;
    },
  };
});

type MediaListener = (event: MediaQueryListEvent) => void;

/** matchMedia whose dark-scheme answer the test can flip. */
function mockSystemScheme(initiallyDark: boolean) {
  let dark = initiallyDark;
  const listeners = new Set<MediaListener>();
  window.matchMedia = vi.fn().mockImplementation((query: string) => ({
    get matches() {
      return query.includes("dark") ? dark : false;
    },
    media: query,
    addEventListener: (_: string, listener: MediaListener) =>
      listeners.add(listener),
    removeEventListener: (_: string, listener: MediaListener) =>
      listeners.delete(listener),
  }));
  return (nextDark: boolean) => {
    dark = nextDark;
    for (const listener of listeners) {
      listener({ matches: nextDark } as MediaQueryListEvent);
    }
  };
}

function lastProps() {
  const props = fileProps[fileProps.length - 1];
  if (!props) throw new Error("File was not rendered");
  return props as {
    file: { name: string; contents: string; lang: string };
    options: Record<string, unknown>;
    style: Record<string, string>;
  };
}

describe("CodeSnippet", () => {
  beforeEach(() => {
    fileProps.length = 0;
    mockSystemScheme(false);
    useUIStore.setState({
      theme: "system",
      codeThemeDark: "pierre-dark",
      codeThemeLight: "pierre-light",
    });
  });

  it("renders in-memory source through Pierre File as a bare snippet", () => {
    render(<CodeSnippet language="ts" source="const x = 1;" />);

    const { file, options } = lastProps();
    expect(file).toMatchObject({
      contents: "const x = 1;",
      lang: "typescript",
    });
    expect(options).toMatchObject({
      disableFileHeader: true,
      disableLineNumbers: true,
      overflow: "scroll",
      preferredHighlighter: "highlights",
      theme: { dark: "pierre-dark", light: "pierre-light" },
    });
  });

  it("carries chat font and spacing across the shadow root", () => {
    render(<CodeSnippet language="ts" source="x" />);

    expect(lastProps().style).toMatchObject({
      "--diffs-font-family": "var(--font-mono)",
      "--diffs-font-size": "var(--text-13)",
    });
  });

  it.each([
    ["rust", "rust"],
    ["sh", "zsh"],
    ["python", "python"],
    ["text", "text"],
    ["definitely-unknown", "definitely-unknown"],
  ])("maps fence language %s to %s", (fence, lang) => {
    render(<CodeSnippet language={fence} source="x" />);
    expect(lastProps().file.lang).toBe(lang);
  });

  it("follows separate dark and light selections without remounting", () => {
    render(<CodeSnippet language="ts" source="x" />);

    act(() => {
      useUIStore.getState().setCodeTheme("dark", "tokyo-night");
      useUIStore.getState().setCodeTheme("light", "github-light");
    });
    expect(lastProps().options.theme).toEqual({
      dark: "tokyo-night",
      light: "github-light",
    });

    act(() => useUIStore.getState().setCodeTheme("dark", "no-longer-bundled"));
    expect(lastProps().options.theme).toEqual({
      dark: "pierre-dark",
      light: "github-light",
    });
  });

  it("pins the theme variant to forced app modes opposite the OS", () => {
    mockSystemScheme(false);
    useUIStore.setState({ theme: "dark" });
    const { rerender } = render(<CodeSnippet language="ts" source="x" />);
    expect(lastProps().options.themeType).toBe("dark");

    mockSystemScheme(true);
    act(() => useUIStore.setState({ theme: "light" }));
    rerender(<CodeSnippet language="ts" source="x" />);
    expect(lastProps().options.themeType).toBe("light");
  });

  it("tracks OS appearance changes in system mode", () => {
    const setSystemDark = mockSystemScheme(true);
    render(<CodeSnippet language="ts" source="x" />);
    expect(lastProps().options.themeType).toBe("dark");

    act(() => setSystemDark(false));
    expect(lastProps().options.themeType).toBe("light");
  });
});

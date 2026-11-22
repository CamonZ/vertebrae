import { afterEach, describe, expect, it, vi } from "vitest";
import { act, render, screen } from "@testing-library/react";
import type { ThinkingLineVariant } from "./shaders";

const VARIANTS: ThinkingLineVariant[] = ["shimmer", "uplink", "assembler"];

/**
 * A WebGL2 context whose every call succeeds: shaders compile, programs link
 * and uniform lookups return handles. Enough for the renderer's probe.
 */
function fakeWebGl2(): WebGL2RenderingContext {
  return new Proxy({} as WebGL2RenderingContext, {
    get: (_, key) =>
      typeof key === "string" && key === key.toUpperCase() ? 0 : () => ({}),
  });
}

/** Stubs canvas contexts; the renderer is a singleton, so load it fresh. */
async function loadWith({ webgl2 }: { webgl2: boolean }) {
  const created: HTMLCanvasElement[] = [];
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockImplementation(
    function (this: HTMLCanvasElement, kind: string) {
      created.push(this);
      if (kind === "2d") return {} as CanvasRenderingContext2D;
      if (kind === "webgl2") return webgl2 ? fakeWebGl2() : null;
      return null;
    } as typeof HTMLCanvasElement.prototype.getContext
  );
  vi.resetModules();
  const { ThinkingLine } = await import("./ThinkingLine");
  return { ThinkingLine, created };
}

describe("ThinkingLine fallback", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it.each(VARIANTS)(
    "shows the %s status text when WebGL2 is unavailable",
    async (variant) => {
      const { ThinkingLine } = await loadWith({ webgl2: false });
      render(<ThinkingLine variant={variant} text="Thinking…" />);
      expect(screen.queryByTestId("thinking-line")).not.toBeInTheDocument();
      const fallback = screen.getByTestId("thinking-line-fallback");
      expect(fallback).toHaveAttribute("data-variant", variant);
      expect(fallback).toHaveTextContent("Thinking…");
    }
  );

  it("shows a hairline instead of text when asked to", async () => {
    const { ThinkingLine } = await loadWith({ webgl2: false });
    render(
      <ThinkingLine variant="uplink" text="Thinking…" fallback="hairline" />
    );
    expect(screen.getByTestId("thinking-line-fallback")).toHaveTextContent("");
  });

  it.each(VARIANTS)("draws %s on a canvas with WebGL2", async (variant) => {
    const { ThinkingLine } = await loadWith({ webgl2: true });
    render(<ThinkingLine variant={variant} text="Thinking…" />);
    expect(screen.getByTestId("thinking-line")).toHaveAttribute(
      "data-variant",
      variant
    );
    expect(
      screen.queryByTestId("thinking-line-fallback")
    ).not.toBeInTheDocument();
  });

  it("falls back while the GPU context is lost and redraws on restore", async () => {
    const { ThinkingLine, created } = await loadWith({ webgl2: true });
    render(<ThinkingLine variant="shimmer" text="Thinking…" />);
    expect(screen.getByTestId("thinking-line")).toBeInTheDocument();

    // the renderer's shared GL canvas is the one that asked for webgl2
    const glCanvas = created.find(
      (_, i) =>
        vi.mocked(HTMLCanvasElement.prototype.getContext).mock.calls[i][0] ===
        "webgl2"
    )!;
    act(() => {
      glCanvas.dispatchEvent(new Event("webglcontextlost"));
    });
    expect(screen.getByTestId("thinking-line-fallback")).toHaveTextContent(
      "Thinking…"
    );

    act(() => {
      glCanvas.dispatchEvent(new Event("webglcontextrestored"));
    });
    expect(screen.getByTestId("thinking-line")).toBeInTheDocument();
  });
});

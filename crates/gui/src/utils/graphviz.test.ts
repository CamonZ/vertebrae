import { describe, expect, it } from "vitest";
import { loadGraphviz } from "./graphviz";

describe("Graphviz runtime", () => {
  it("loads locally and renders a minimal DOT graph", async () => {
    const graphviz = await loadGraphviz();
    const svg = graphviz.dot("digraph { a -> b; }");

    expect(graphviz.version()).toBeTruthy();
    expect(svg).toContain("<svg");
    expect(svg).toContain("<title>a</title>");
    expect(svg).toContain("<title>b</title>");
  });
});

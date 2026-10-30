import { render, waitFor } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { getHighlighterType } from "@pierre/diffs";
import { CODE_HIGHLIGHTER } from "../../utils/codeAppearance";
import CodeSnippet from "./CodeSnippet";

// Unmocked Pierre: proves fenced snippets really highlight through the engine
// CODE_HIGHLIGHTER selects (Highlights wherever WebAssembly SIMD exists).
describe("CodeSnippet with Pierre", () => {
  it("highlights with the selected engine and no header or line numbers", async () => {
    const { container } = render(
      <CodeSnippet language="ts" source={"const answer = 42;"} />
    );

    const host = container.querySelector("diffs-container");
    expect(host).not.toBeNull();
    await waitFor(() => {
      const code = host!.shadowRoot?.querySelector("[data-code]");
      expect(code?.textContent).toContain("const answer = 42;");
      expect(code?.querySelector("span[style]")).not.toBeNull();
    });

    expect(CODE_HIGHLIGHTER).toBe("highlights");
    expect(getHighlighterType()).toBe("highlights");
    const shadow = host!.shadowRoot!;
    expect(shadow.querySelector("[data-diffs-header]")).toBeNull();
    // Pierre keeps a collapsed gutter and hides numbers via this attribute.
    expect(
      shadow.querySelector("pre[data-disable-line-numbers]")
    ).not.toBeNull();
  });
});

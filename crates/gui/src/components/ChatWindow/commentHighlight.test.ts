import { describe, expect, it } from "vitest";
import { findQuoteRange } from "./commentHighlight";

function transcript(html: string): HTMLElement {
  const root = document.createElement("div");
  root.innerHTML = html;
  document.body.append(root);
  return root;
}

describe("findQuoteRange", () => {
  it("finds a quote that spans blocks despite differing whitespace", () => {
    const root = transcript(
      '<div data-local-chat-assistant-response-id="r1"><p>First point.</p>\n<ul><li>Second point.</li></ul></div>'
    );
    const range = findQuoteRange(root, {
      responseId: "r1",
      quote: "point.\n\nSecond",
      contextBefore: "First ",
      contextAfter: " point.",
    });
    expect(range?.toString().replace(/\s+/g, "")).toBe("point.Second");
    root.remove();
  });

  it("picks the occurrence whose surrounding text matches the context", () => {
    const root = transcript(
      '<div data-local-chat-assistant-response-id="r1"><p>alpha the parser. beta the parser.</p></div>'
    );
    const range = findQuoteRange(root, {
      responseId: "r1",
      quote: "the parser",
      contextBefore: "beta ",
      contextAfter: ".",
    });
    expect(range?.startOffset).toBe("alpha the parser. beta ".length);
    root.remove();
  });

  it("returns null for another response or missing text", () => {
    const root = transcript(
      '<div data-local-chat-assistant-response-id="r1"><p>Hello</p></div>'
    );
    const comment = { quote: "Hello", contextBefore: "", contextAfter: "" };
    expect(findQuoteRange(root, { ...comment, responseId: "r2" })).toBeNull();
    expect(
      findQuoteRange(root, { ...comment, responseId: "r1", quote: "Bye" })
    ).toBeNull();
    root.remove();
  });
});

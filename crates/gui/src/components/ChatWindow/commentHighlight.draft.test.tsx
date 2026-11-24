import { cleanup, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ACTIVE_HIGHLIGHT, useDraftHighlight } from "./commentHighlight";

// jsdom has no CSS Custom Highlight API; a minimal stand-in records ranges.
class FakeHighlight extends Set<Range> {}
const registry = new Map<string, FakeHighlight>();

beforeEach(() => {
  registry.clear();
  Object.assign(globalThis, { Highlight: FakeHighlight });
  Object.defineProperty(CSS, "highlights", {
    configurable: true,
    value: registry,
  });
});
afterEach(() => {
  cleanup();
  delete (globalThis as { Highlight?: unknown }).Highlight;
  delete (CSS as { highlights?: unknown }).highlights;
});

function Pane({ range }: { range: Range | null }) {
  useDraftHighlight(range);
  return null;
}

describe("useDraftHighlight", () => {
  it("keeps the range marked while set and clears it when released", () => {
    const text = document.createTextNode("quoted text");
    document.body.append(text);
    const range = document.createRange();
    range.selectNodeContents(text);

    const view = render(<Pane range={range} />);
    expect([...(registry.get(ACTIVE_HIGHLIGHT) ?? [])]).toEqual([range]);

    view.rerender(<Pane range={null} />);
    expect([...(registry.get(ACTIVE_HIGHLIGHT) ?? [])]).toEqual([]);
    text.remove();
  });
});

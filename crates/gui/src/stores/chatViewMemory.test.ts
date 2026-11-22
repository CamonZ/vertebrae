import { afterEach, describe, expect, it } from "vitest";
import {
  chatFocusArea,
  chatFocusAreaOf,
  forgetChatView,
  restoreChatScroll,
  saveChatFocusArea,
  saveChatScroll,
} from "./chatViewMemory";

/** An element whose box sits `top`..`top + height` in viewport coordinates. */
function box(top: number, height = 100) {
  const element = document.createElement("div");
  document.body.append(element);
  element.getBoundingClientRect = () =>
    ({ top, bottom: top + height, height }) as DOMRect;
  return element;
}

afterEach(() => {
  forgetChatView();
  document.body.innerHTML = "";
});

describe("chat scroll memory", () => {
  it("remembers the first visible event and restores its offset", () => {
    const viewport = box(100, 400);
    const anchors = new Map([
      ["above", box(-50)], // scrolled out of view
      ["first", box(130)],
      ["second", box(260)],
    ]);
    saveChatScroll("s1", viewport, false, anchors);

    // Remounted: the same event now renders 500px lower.
    viewport.scrollTop = 0;
    const remounted = new Map([["first", box(630)]]);
    expect(restoreChatScroll("s1", viewport, remounted)).toBe(true);
    expect(viewport.scrollTop).toBe(500);
  });

  it("leaves a chat that was following the tail to bottom-follow", () => {
    const viewport = box(0, 400);
    saveChatScroll("s1", viewport, true, new Map([["a", box(10)]]));
    expect(restoreChatScroll("s1", viewport, new Map([["a", box(10)]]))).toBe(
      false
    );
  });

  it("does not restore unknown chats or anchors that are gone", () => {
    const viewport = box(0, 400);
    expect(restoreChatScroll("s1", viewport, new Map())).toBe(false);
    saveChatScroll("s1", viewport, false, new Map([["a", box(10)]]));
    expect(restoreChatScroll("s1", viewport, new Map())).toBe(false);
  });

  it("skips disconnected anchors", () => {
    const viewport = box(0, 400);
    const detached = box(5);
    detached.remove();
    saveChatScroll(
      "s1",
      viewport,
      false,
      new Map([
        ["detached", detached],
        ["live", box(40)],
      ])
    );
    viewport.scrollTop = 0;
    expect(
      restoreChatScroll("s1", viewport, new Map([["live", box(90)]]))
    ).toBe(true);
    expect(viewport.scrollTop).toBe(50);
  });
});

describe("chat focus memory", () => {
  it("returns to the composer by default", () => {
    expect(chatFocusArea("s1")).toBe("composer");
  });

  it("remembers the area per chat until forgotten", () => {
    saveChatFocusArea("s1", "transcript");
    saveChatFocusArea("s2", "changes");
    expect(chatFocusArea("s1")).toBe("transcript");
    forgetChatView("s1");
    expect(chatFocusArea("s1")).toBe("composer");
    expect(chatFocusArea("s2")).toBe("changes");
  });

  it("classifies a focused element by the chat area holding it", () => {
    document.body.innerHTML = `
      <div data-chat-area="changes"><button id="c"></button></div>
      <div data-transcript-viewport><span id="t" tabindex="-1"></span></div>
      <textarea data-testid="local-chat-composer" id="m"></textarea>
      <button id="x"></button>`;
    const area = (id: string) => chatFocusAreaOf(document.getElementById(id)!);
    expect(area("c")).toBe("changes");
    expect(area("t")).toBe("transcript");
    expect(area("m")).toBe("composer");
    expect(area("x")).toBeNull();
  });
});

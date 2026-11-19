import { vi } from "vitest";

/**
 * A fake transcript layout for jsdom, which has no geometry: element boxes
 * and text nodes wrapped at given offsets, 20px lines and 8px characters.
 */
export const LINE = 20;
export const CHAR = 8;

interface Box {
  left: number;
  top: number;
  width: number;
  height: number;
}

const elementBoxes = new Map<Element, Box>();
const textLayouts = new Map<
  Text,
  { top: number; left: number; breaks: number[] }
>();

export function rect({ left, top, width, height }: Box): DOMRect {
  return {
    left,
    top,
    width,
    height,
    right: left + width,
    bottom: top + height,
    x: left,
    y: top,
    toJSON: () => ({}),
  } as DOMRect;
}

function charBox(node: Text, offset: number): Box {
  const { top, left, breaks } = textLayouts.get(node)!;
  let line = 0;
  let start = 0;
  for (const at of breaks) {
    if (offset < at) break;
    line += 1;
    start = at;
  }
  return {
    left: left + (offset - start) * CHAR,
    top: top + line * LINE,
    width: CHAR,
    height: LINE,
  };
}

function textRects(node: Text, from: number, to: number): Box[] {
  const rects: Box[] = [];
  for (let at = from; at < to; at += 1) {
    const box = charBox(node, at);
    const last = rects[rects.length - 1];
    if (last && last.top === box.top) last.width += CHAR;
    else rects.push({ ...box });
  }
  return rects;
}

/** One rect per line box the range covers, across laid-out text nodes. */
function rangeRects(range: Range): DOMRect[] {
  const rects: Box[] = [];
  for (const [node] of textLayouts) {
    if (!node.isConnected || !range.intersectsNode(node)) continue;
    const from = node === range.startContainer ? range.startOffset : 0;
    const to = node === range.endContainer ? range.endOffset : node.length;
    rects.push(...textRects(node, from, to));
  }
  return rects.map(rect);
}

export function layout(element: Element, box: Box) {
  elementBoxes.set(element, box);
}

/**
 * Lay out an element's first text node from (`left`, `top`), wrapping at
 * `breaks`.
 */
export function layoutText(
  element: Element,
  top: number,
  breaks: number[] = [],
  left = 100
) {
  textLayouts.set(element.firstChild as Text, { top, left, breaks });
  layout(element, {
    left,
    top,
    width: 400,
    height: (breaks.length + 1) * LINE,
  });
}

const originals = {
  getClientRects: Range.prototype.getClientRects,
  getBoundingClientRect: Range.prototype.getBoundingClientRect,
};

export function installTranscriptLayout() {
  vi.spyOn(Element.prototype, "getBoundingClientRect").mockImplementation(
    function (this: Element) {
      return rect(
        elementBoxes.get(this) ?? { left: 0, top: 0, width: 0, height: 0 }
      );
    }
  );
  Range.prototype.getClientRects = function (this: Range) {
    return rangeRects(this) as unknown as DOMRectList;
  };
  Range.prototype.getBoundingClientRect = function (this: Range) {
    const rects = rangeRects(this);
    if (!rects.length) return rect({ left: 0, top: 0, width: 0, height: 0 });
    const top = Math.min(...rects.map((r) => r.top));
    const bottom = Math.max(...rects.map((r) => r.bottom));
    const left = Math.min(...rects.map((r) => r.left));
    const right = Math.max(...rects.map((r) => r.right));
    return rect({ left, top, width: right - left, height: bottom - top });
  };
}

export function uninstallTranscriptLayout() {
  Range.prototype.getClientRects = originals.getClientRects;
  Range.prototype.getBoundingClientRect = originals.getBoundingClientRect;
  elementBoxes.clear();
  textLayouts.clear();
}

/**
 * A user turn, a tool group and an assistant response whose first paragraph
 * wraps after "first line ", laid out from y=0 to y=140.
 */
export const TRANSCRIPT_HTML = `
  <div class="evrow evrow--user"><div class="evbody">
    <div class="ev-promptline"><span class="ev-you">You</span></div>
    <div class="ev-text">hello there</div>
  </div></div>
  <div class="tool-activity-group"><button>4 calls</button></div>
  <div class="evrow evrow--agent"><div class="evbody">
    <div class="ev-speaker">Claude</div>
    <div class="evprose" data-local-chat-assistant-response-id="r1"><p>first line second</p><ul><li>  item one</li></ul></div>
  </div></div>
  <div role="status">Loading older messages…</div>`;

export function layoutTranscript(content: HTMLElement) {
  const q = (selector: string) => content.querySelector(selector)!;
  for (const row of content.querySelectorAll(".evrow, .evbody"))
    layout(row, { left: 90, top: 0, width: 500, height: 140 });
  layout(q(".ev-promptline"), { left: 100, top: -20, width: 40, height: 20 });
  layoutText(q(".ev-you"), -20);
  layoutText(q(".ev-text"), 0);
  layout(q(".tool-activity-group"), {
    left: 100,
    top: 40,
    width: 400,
    height: 24,
  });
  layoutText(q(".tool-activity-group button"), 42);
  layoutText(q(".ev-speaker"), 60);
  layoutText(q(".evprose p"), 80, [11]);
  layoutText(q(".evprose li"), 120);
  layout(q(".evprose"), { left: 100, top: 80, width: 400, height: 60 });
  layout(q("ul"), { left: 100, top: 120, width: 400, height: 20 });
  layout(q("[role='status']"), { left: 100, top: 160, width: 400, height: 20 });
}

/**
 * The keyboard caret model of a chat transcript, read from the rendered DOM on
 * demand. An *item* is one block of transcript text (user text, a stretch of
 * assistant prose); tool groups, cards and prompts between items are not
 * addressable. Each item reads as one flat string with a line break between
 * its paragraphs, and the caret is an index into it. Nothing here is React
 * state: text is measured when a key moves the caret, so moving it never
 * re-renders the message list.
 */

export interface TextPoint {
  node: Node;
  offset: number;
}

export interface LineBox {
  top: number;
  bottom: number;
  left: number;
  right: number;
}

/** Text blocks the caret walks. */
const ITEM_SELECTOR = ".ev-text, .evprose";
/** Rows whose text is not transcript prose (tool output, sub-agents). */
const OPAQUE_SELECTOR =
  ".ev-tools, .tool-activity-group, .evrow--system, .subthread";
/**
 * Text inside an item that is not on screen. Inline buttons (file and entity
 * references) are prose and stay in their line.
 */
const SKIP_TEXT_SELECTOR =
  "[aria-hidden='true'], .ev-cursor, .sr-only, [data-transcript-skip]";
/** Elements that start a new paragraph. */
const BLOCK_SELECTOR =
  "p, li, pre, blockquote, h1, h2, h3, h4, h5, h6, td, th, dt, dd, figcaption, div";
const WORD_CHAR = /[\p{L}\p{N}_]/u;
const APOSTROPHE = /['’]/;

function hasBox(element: Element): boolean {
  const rect = element.getBoundingClientRect();
  return rect.width > 0 && rect.height > 0;
}

function visibleTextNodes(item: HTMLElement): Text[] {
  const walker = document.createTreeWalker(item, NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      if (!node.nodeValue) return NodeFilter.FILTER_REJECT;
      const skipped = node.parentElement?.closest(SKIP_TEXT_SELECTOR);
      return skipped && item.contains(skipped)
        ? NodeFilter.FILTER_REJECT
        : NodeFilter.FILTER_ACCEPT;
    },
  });
  const nodes: Text[] = [];
  for (let node = walker.nextNode(); node; node = walker.nextNode())
    nodes.push(node as Text);
  return nodes;
}

/** The transcript's items in document order: innermost text blocks with text. */
export function transcriptItems(content: HTMLElement): HTMLElement[] {
  const candidates = Array.from(
    content.querySelectorAll<HTMLElement>(ITEM_SELECTOR)
  );
  return candidates.filter(
    (candidate) =>
      !candidate.querySelector(ITEM_SELECTOR) &&
      !candidate.parentElement?.closest(OPAQUE_SELECTOR) &&
      !!candidate.textContent?.trim() &&
      hasBox(candidate)
  );
}

interface Segment {
  node: Text;
  /** Index of the node's first character in the item text. */
  start: number;
}

export interface ItemText {
  item: HTMLElement;
  /** Visible text with "\n" between paragraphs. */
  text: string;
  segments: Segment[];
  /** Indices of the paragraph breaks (the inserted "\n"s). */
  breaks: number[];
}

function blockOf(node: Text, item: HTMLElement): Element {
  const block = node.parentElement?.closest(BLOCK_SELECTOR);
  return block && item.contains(block) ? block : item;
}

export function readItem(item: HTMLElement): ItemText {
  const segments: Segment[] = [];
  const breaks: number[] = [];
  let text = "";
  let block: Element | null = null;
  for (const node of visibleTextNodes(item)) {
    const nodeBlock = blockOf(node, item);
    // Whitespace between blocks is markup, not text.
    if (!node.data.trim() && nodeBlock !== block) continue;
    if (block && nodeBlock !== block) {
      breaks.push(text.length);
      text += "\n";
    }
    block = nodeBlock;
    segments.push({ node, start: text.length });
    text += node.data;
  }
  return { item, text, segments, breaks };
}

/** The DOM point of `index`; a paragraph break is the end of its paragraph. */
export function pointAt(item: ItemText, index: number): TextPoint {
  const { segments } = item;
  for (let at = 0; at < segments.length; at += 1) {
    const { node, start } = segments[at];
    if (index < start + node.length) return { node, offset: index - start };
    const next = segments[at + 1];
    if (!next || index < next.start) return { node, offset: node.length };
  }
  return { node: item.item, offset: 0 };
}

/** Document order of two points: negative, zero or positive. */
export function comparePoints(a: TextPoint, b: TextPoint): number {
  const range = document.createRange();
  try {
    range.setStart(a.node, a.offset);
    return -range.comparePoint(b.node, b.offset);
  } catch {
    return 0;
  } finally {
    range.detach();
  }
}

/** The index of a DOM point inside the item (clamped to its text). */
export function indexOf(item: ItemText, point: TextPoint): number {
  const segment = item.segments.find(({ node }) => node === point.node);
  if (segment)
    return segment.start + Math.min(point.offset, segment.node.length);
  const after = item.segments.find(
    ({ node }) => comparePoints(point, { node, offset: 0 }) >= 0
  );
  return after ? after.start : item.text.length;
}

function charBox(item: ItemText, index: number): LineBox | null {
  if (index < 0 || index >= item.text.length || item.breaks.includes(index))
    return null;
  const { node, offset } = pointAt(item, index);
  const range = document.createRange();
  range.setStart(node, offset);
  range.setEnd(node, offset + 1);
  const rect = range.getBoundingClientRect();
  range.detach();
  return rect.height > 0
    ? { top: rect.top, bottom: rect.bottom, left: rect.left, right: rect.right }
    : null;
}

function center(box: LineBox): number {
  return (box.top + box.bottom) / 2;
}

/** Whether `box` sits on the line box `line` (their middles overlap). */
export function sameLine(line: LineBox, box: LineBox): boolean {
  const middle = center(box);
  return middle > line.top && middle < line.bottom;
}

export interface Line extends LineBox {
  /** Item indices of the line's first character and its end. */
  start: number;
  end: number;
}

/** First offset in [from, to) whose character sits below `above`. */
function firstOffsetBelow(
  range: Range,
  node: Text,
  above: LineBox,
  from: number,
  to: number
): number {
  let low = from;
  let high = to;
  while (low < high) {
    const middle = (low + high) >> 1;
    range.setStart(node, middle);
    range.setEnd(node, middle + 1);
    const box = range.getBoundingClientRect();
    if (box.height > 0 && center(box) > above.bottom) high = middle;
    else low = middle + 1;
  }
  return low;
}

/** The item's visual lines, in client coordinates as of now. */
export function measureLines(item: ItemText): Line[] {
  const range = document.createRange();
  const lines: Line[] = [];
  for (const { node, start } of item.segments) {
    range.selectNodeContents(node);
    const boxes: LineBox[] = [];
    for (const rect of Array.from(range.getClientRects())) {
      if (rect.width <= 0 || rect.height <= 0) continue;
      const last = boxes[boxes.length - 1];
      if (last && sameLine(last, rect)) {
        last.left = Math.min(last.left, rect.left);
        last.right = Math.max(last.right, rect.right);
      } else {
        boxes.push({
          top: rect.top,
          bottom: rect.bottom,
          left: rect.left,
          right: rect.right,
        });
      }
    }
    let from = 0;
    boxes.forEach((box, at) => {
      const to =
        at < boxes.length - 1
          ? firstOffsetBelow(range, node, box, from + 1, node.length)
          : node.length;
      const line = lines[lines.length - 1];
      const joins =
        line && sameLine(line, box) && !item.breaks.includes(line.end);
      if (joins) {
        line.end = start + to;
        line.left = Math.min(line.left, box.left);
        line.right = Math.max(line.right, box.right);
        line.top = Math.min(line.top, box.top);
        line.bottom = Math.max(line.bottom, box.bottom);
      } else {
        lines.push({ ...box, start: start + from, end: start + to });
      }
      from = to;
    });
  }
  range.detach();
  return lines;
}

/** Where the caret is: an item, an index into its text, and its line side. */
export interface CaretPosition {
  items: HTMLElement[];
  itemIndex: number;
  item: ItemText;
  index: number;
  /** At a wrap boundary, sit at the end of the earlier line. */
  after: boolean;
}

export function caretPoint(position: CaretPosition): TextPoint {
  return pointAt(position.item, position.index);
}

/** The line holding the caret. */
export function lineIndexOf(
  lines: readonly Line[],
  index: number,
  after: boolean
): number {
  for (let at = lines.length - 1; at >= 0; at -= 1) {
    const line = lines[at];
    if (line.start > index) continue;
    if (after && at > 0 && line.start === index && lines[at - 1].end === index)
      return at - 1;
    return at;
  }
  return 0;
}

/** Width of the block past a line's end, relative to the line height. */
const END_CARET_WIDTH = 0.45;

/**
 * The caret's box: a block over the character after it, or, at a line or
 * paragraph end, a space-wide block just past the one before it.
 */
export function caretBox(position: CaretPosition): LineBox | null {
  const { item, index, after } = position;
  const next = after ? null : charBox(item, index);
  if (next && next.right > next.left) return next;
  const previous = charBox(item, index - 1) ?? next;
  if (!previous) return null;
  const left = previous === next ? previous.left : previous.right;
  const width = (previous.bottom - previous.top) * END_CARET_WIDTH;
  return { ...previous, left, right: left + width };
}

function atItem(
  items: HTMLElement[],
  itemIndex: number,
  index: (item: ItemText) => number
): CaretPosition {
  const item = readItem(items[itemIndex]);
  return { items, itemIndex, item, index: index(item), after: false };
}

/** A position in the item before or after, or null at the transcript's edge. */
function neighbour(
  position: CaretPosition,
  direction: -1 | 1,
  index: (item: ItemText) => number
): CaretPosition | null {
  const itemIndex = position.itemIndex + direction;
  if (itemIndex < 0 || itemIndex >= position.items.length) return null;
  return atItem(position.items, itemIndex, index);
}

const startOf = () => 0;
const endOf = (item: ItemText) => item.text.length;

/** A word character, counting an apostrophe inside a word ("I’d"). */
function inWord(text: string, index: number): boolean {
  const char = text[index];
  if (char === undefined) return false;
  if (WORD_CHAR.test(char)) return true;
  return (
    APOSTROPHE.test(char) &&
    WORD_CHAR.test(text[index - 1] ?? "") &&
    WORD_CHAR.test(text[index + 1] ?? "")
  );
}

function wordForward(text: string, from: number): number {
  let index = from;
  while (index < text.length && !inWord(text, index)) index += 1;
  while (index < text.length && inWord(text, index)) index += 1;
  return index;
}

function wordBackward(text: string, from: number): number {
  let index = from;
  while (index > 0 && !inWord(text, index - 1)) index -= 1;
  while (index > 0 && inWord(text, index - 1)) index -= 1;
  return index;
}

/** Paragraph starts and ends, in order. */
function paragraphs(item: ItemText): { starts: number[]; ends: number[] } {
  return {
    starts: [0, ...item.breaks.map((index) => index + 1)],
    ends: [...item.breaks, item.text.length],
  };
}

export type Motion =
  | "character"
  | "word"
  | "paragraph"
  | "lineboundary"
  | "item"
  | "document";

/**
 * The caret moved by one `motion`. Character, word, paragraph and item moves
 * continue into the neighbouring item at an item's edge; paragraph and item
 * moves land on the end going down and the start going up.
 */
export function move(
  position: CaretPosition,
  motion: Motion,
  direction: -1 | 1
): CaretPosition {
  const { item, index } = position;
  const length = item.text.length;
  const forward = direction === 1;
  const stay = (next: number, after = false) => ({
    ...position,
    index: next,
    after,
  });
  switch (motion) {
    case "character":
      if (forward ? index < length : index > 0) return stay(index + direction);
      return (
        neighbour(position, direction, forward ? startOf : endOf) ?? position
      );
    case "word": {
      const next = forward
        ? wordForward(item.text, index)
        : wordBackward(item.text, index);
      if (next !== index) return stay(next);
      return (
        neighbour(position, direction, (target) =>
          forward
            ? wordForward(target.text, 0)
            : wordBackward(target.text, target.text.length)
        ) ?? position
      );
    }
    case "paragraph": {
      const { starts, ends } = paragraphs(item);
      const next = forward
        ? ends.find((end) => end > index)
        : starts.filter((start) => start < index).pop();
      if (next !== undefined) return stay(next);
      return (
        neighbour(position, direction, (target) =>
          forward
            ? paragraphs(target).ends[0]
            : paragraphs(target).starts.pop()!
        ) ?? position
      );
    }
    case "lineboundary": {
      const lines = measureLines(item);
      const line = lines[lineIndexOf(lines, index, position.after)];
      if (!line) return position;
      return forward ? stay(line.end, true) : stay(line.start);
    }
    case "item":
      if (forward ? index < length : index > 0)
        return stay(forward ? length : 0);
      return (
        neighbour(position, direction, forward ? endOf : startOf) ?? position
      );
    case "document":
      return forward
        ? atItem(position.items, position.items.length - 1, endOf)
        : atItem(position.items, 0, startOf);
  }
}

/** The caret position on `line` nearest the horizontal position `x`. */
function nearest(
  position: CaretPosition,
  lines: readonly Line[],
  lineIndex: number,
  x: number
): CaretPosition {
  const line = lines[lineIndex];
  let low = line.start;
  let high = line.end;
  while (low < high) {
    const middle = (low + high) >> 1;
    const box = charBox(position.item, middle);
    if (box && (box.left + box.right) / 2 > x) high = middle;
    else low = middle + 1;
  }
  // The end of a wrapped line is also the next line's start.
  const wraps = low === line.end && lines[lineIndex + 1]?.start === low;
  return { ...position, index: low, after: wraps };
}

/**
 * The line at `x` on the visual row starting at `from` and running in
 * `direction` (table cells share a row), or the row's nearest line.
 */
function onRow(
  lines: readonly Line[],
  from: number,
  direction: -1 | 1,
  x: number
): number {
  let best = from;
  let bestDistance = Infinity;
  for (
    let at = from;
    at >= 0 && at < lines.length && sameLine(lines[from], lines[at]);
    at += direction
  ) {
    const { left, right } = lines[at];
    const distance = x < left ? left - x : x > right ? x - right : 0;
    if (distance < bestDistance) {
      best = at;
      bestDistance = distance;
    }
  }
  return best;
}

/** One visual row up or down, keeping to the column at `x`. */
export function moveLine(
  position: CaretPosition,
  direction: -1 | 1,
  x: number
): CaretPosition {
  const lines = measureLines(position.item);
  const lineIndex = lineIndexOf(lines, position.index, position.after);
  let next = lineIndex;
  while (
    next >= 0 &&
    next < lines.length &&
    lines[lineIndex] &&
    sameLine(lines[lineIndex], lines[next])
  )
    next += direction;
  if (next >= 0 && next < lines.length)
    return nearest(position, lines, onRow(lines, next, direction, x), x);
  const target = neighbour(position, direction, startOf);
  if (!target) return position;
  const targetLines = measureLines(target.item);
  if (!targetLines.length) return target;
  const edge = direction === 1 ? 0 : targetLines.length - 1;
  return nearest(
    target,
    targetLines,
    onRow(targetLines, edge, direction, x),
    x
  );
}

/** Lines up or down until the next one would travel further than `distance`. */
export function movePage(
  position: CaretPosition,
  direction: -1 | 1,
  x: number,
  distance: number
): CaretPosition {
  const origin = caretBox(position)?.top ?? 0;
  let current = position;
  for (;;) {
    const next = moveLine(current, direction, x);
    if (next.itemIndex === current.itemIndex && next.index === current.index)
      return current;
    const top = caretBox(next)?.top ?? origin;
    if (Math.abs(top - origin) > distance)
      return current === position ? next : current;
    current = next;
  }
}

/**
 * Where a caret left at (`item`, `index`) is now. A loaded history page
 * re-keys (remounts) the rows above it; its item is then found again by its
 * distance from the end (`fromEnd`).
 */
export function locate(
  content: HTMLElement,
  caret: { item: HTMLElement; index: number; after: boolean; fromEnd: number }
): CaretPosition | null {
  const items = transcriptItems(content);
  let itemIndex = items.indexOf(caret.item);
  if (itemIndex < 0) itemIndex = items.length - caret.fromEnd;
  if (itemIndex < 0 || itemIndex >= items.length) return null;
  const item = readItem(items[itemIndex]);
  return {
    items,
    itemIndex,
    item,
    index: Math.min(caret.index, item.text.length),
    after: caret.after,
  };
}

/** The start of the last line fully inside `viewport` (or reaching into it). */
export function lastVisibleLine(
  content: HTMLElement,
  viewport: LineBox
): CaretPosition | null {
  const items = transcriptItems(content);
  for (let itemIndex = items.length - 1; itemIndex >= 0; itemIndex -= 1) {
    const rect = items[itemIndex].getBoundingClientRect();
    if (rect.top >= viewport.bottom || rect.bottom <= viewport.top) continue;
    const item = readItem(items[itemIndex]);
    const lines = measureLines(item);
    const visible = (line: Line, full: boolean) =>
      full
        ? line.top >= viewport.top - 1 && line.bottom <= viewport.bottom + 1
        : line.top < viewport.bottom && line.bottom > viewport.top;
    for (const full of [true, false]) {
      for (let lineIndex = lines.length - 1; lineIndex >= 0; lineIndex -= 1) {
        if (visible(lines[lineIndex], full))
          return {
            items,
            itemIndex,
            item,
            index: lines[lineIndex].start,
            after: false,
          };
      }
    }
  }
  return null;
}

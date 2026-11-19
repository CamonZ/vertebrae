import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  caretBox,
  caretPoint,
  lastVisibleLine,
  locate,
  measureLines,
  move,
  moveLine,
  pointAt,
  readItem,
  transcriptItems,
  type CaretPosition,
  type Motion,
} from "./transcriptLines";
import {
  TRANSCRIPT_HTML,
  installTranscriptLayout,
  layout,
  layoutText,
  layoutTranscript,
  uninstallTranscriptLayout,
} from "../../test/transcriptLayout";

let content: HTMLElement;

function mount(html: string) {
  content = document.createElement("div");
  content.innerHTML = html;
  document.body.append(content);
}

beforeEach(() => {
  installTranscriptLayout();
  mount(TRANSCRIPT_HTML);
  layoutTranscript(content);
});

afterEach(() => {
  vi.restoreAllMocks();
  uninstallTranscriptLayout();
  content.remove();
});

/** The fixture's items: "hello there" and "first line second\n  item one". */
function at(itemIndex: number, index: number, after = false): CaretPosition {
  const items = transcriptItems(content);
  return { items, itemIndex, item: readItem(items[itemIndex]), index, after };
}

const where = (position: CaretPosition) => [position.itemIndex, position.index];

function walk(
  from: CaretPosition,
  motion: Motion,
  direction: -1 | 1,
  times: number
): number[][] {
  const stops: number[][] = [];
  let position = from;
  for (let step = 0; step < times; step += 1) {
    position = move(position, motion, direction);
    stops.push(where(position));
  }
  return stops;
}

describe("transcript items", () => {
  it("are the text blocks, not tool groups, labels or status rows", () => {
    expect(transcriptItems(content).map((item) => item.className)).toEqual([
      "ev-text",
      "evprose",
    ]);
  });

  it("read as one string with a break between paragraphs", () => {
    const item = readItem(transcriptItems(content)[1]);
    expect(item.text).toBe("first line second\n  item one");
    expect(item.breaks).toEqual([17]);
    const p = content.querySelector("p")!.firstChild;
    const li = content.querySelector("li")!.firstChild;
    // The break is the end of its paragraph; the next index starts the next.
    expect(pointAt(item, 17)).toEqual({ node: p, offset: 17 });
    expect(pointAt(item, 18)).toEqual({ node: li, offset: 0 });
  });

  it("measure into visual lines, a wrapped paragraph taking two", () => {
    const lines = measureLines(readItem(transcriptItems(content)[1]));
    expect(lines.map(({ start, end, top }) => [start, end, top])).toEqual([
      [0, 11, 80],
      [11, 17, 100],
      [18, 28, 120],
    ]);
  });
});

describe("caret motions", () => {
  it("move by character across paragraph breaks and into the next item", () => {
    expect(walk(at(0, 10), "character", 1, 2)).toEqual([
      [0, 11],
      [1, 0],
    ]);
    expect(walk(at(1, 16), "character", 1, 2)).toEqual([
      [1, 17],
      [1, 18],
    ]);
    expect(walk(at(1, 0), "character", -1, 1)).toEqual([[0, 11]]);
  });

  it("move by word, ending at word ends going forward and starts going back", () => {
    expect(walk(at(1, 0), "word", 1, 4)).toEqual([
      [1, 5],
      [1, 10],
      [1, 17],
      [1, 24],
    ]);
    expect(walk(at(1, 0), "word", -1, 2)).toEqual([
      [0, 6],
      [0, 0],
    ]);
  });

  it("keep an apostrophe inside a word", () => {
    content.remove();
    mount(`<div class="ev-text">I’d go</div>`);
    layoutText(content.querySelector(".ev-text")!, 0);
    expect(walk(at(0, 0), "word", 1, 2)).toEqual([
      [0, 3],
      [0, 6],
    ]);
  });

  it("move by paragraph to its end going down and its start going up", () => {
    expect(walk(at(1, 3), "paragraph", 1, 3)).toEqual([
      [1, 17],
      [1, 28],
      [1, 28],
    ]);
    expect(walk(at(1, 28), "paragraph", -1, 3)).toEqual([
      [1, 18],
      [1, 0],
      [0, 0],
    ]);
  });

  it("move to the visual line's ends, sitting after the last character of a wrapped line", () => {
    const end = move(at(1, 3), "lineboundary", 1);
    expect([end.index, end.after]).toEqual([11, true]);
    // Index 11 also starts the next line; the caret stays on this one, a
    // space-wide block (0.45 of the 20px line) past its last character.
    expect(caretBox(end)).toMatchObject({ left: 188, right: 197, top: 80 });
    expect(move(end, "lineboundary", -1).index).toBe(0);
    // A block over the character after the caret.
    expect(caretBox(at(1, 11))).toMatchObject({
      left: 100,
      right: 108,
      top: 100,
    });
  });

  it("move to an item's start and end, then on to the next item", () => {
    expect(walk(at(1, 3), "item", 1, 2)).toEqual([
      [1, 28],
      [1, 28],
    ]);
    expect(walk(at(1, 3), "item", -1, 3)).toEqual([
      [1, 0],
      [0, 0],
      [0, 0],
    ]);
    expect(where(move(at(0, 3), "item", 1))).toEqual([0, 11]);
    expect(where(move(at(0, 11), "item", 1))).toEqual([1, 28]);
  });

  it("move to the transcript's ends", () => {
    expect(where(move(at(1, 3), "document", -1))).toEqual([0, 0]);
    expect(where(move(at(0, 3), "document", 1))).toEqual([1, 28]);
  });

  it("puts the caret at a paragraph end after its last character", () => {
    expect(caretBox(at(1, 17))).toMatchObject({ left: 148, top: 100 });
  });
});

describe("moveLine", () => {
  it("keeps to the column, crossing paragraphs and items", () => {
    // Index 3 sits at x=124.
    const down = moveLine(at(1, 3), 1, 124);
    expect(where(down)).toEqual([1, 14]);
    expect(where(moveLine(down, 1, 124))).toEqual([1, 21]);
    // Up from the first line: the last line of the item above.
    expect(where(moveLine(at(1, 3), -1, 124))).toEqual([0, 3]);
    expect(where(moveLine(at(0, 3), -1, 124))).toEqual([0, 3]);
  });

  it("lands at the end of a shorter or wrapped line", () => {
    const up = moveLine(at(1, 14), -1, 400);
    expect([up.index, up.after]).toEqual([11, true]);
    expect(where(moveLine(at(1, 3), 1, 400))).toEqual([1, 17]);
  });

  it("steps a table row at a time, into the cell under the column", () => {
    content.remove();
    mount(
      `<div class="evprose"><table><tr><td>name</td><td>value</td></tr>` +
        `<tr><td>b</td><td>c</td></tr></table><p>after</p></div>`
    );
    const cells = content.querySelectorAll("td");
    layoutText(cells[0], 0, [], 100);
    layoutText(cells[1], 0, [], 300);
    layoutText(cells[2], 20, [], 100);
    layoutText(cells[3], 20, [], 300);
    layoutText(content.querySelector("p")!, 40);
    layout(content.querySelector(".evprose")!, {
      left: 100,
      top: 0,
      width: 400,
      height: 60,
    });
    // "name\nvalue\nb\nc\nafter": the caret is in "value" at x=316.
    const down = moveLine(at(0, 7), 1, 316);
    expect(where(down)).toEqual([0, 14]);
    expect(caretBox(down)).toMatchObject({ left: 308, top: 20 });
    expect(where(moveLine(down, 1, 316))).toEqual([0, 20]);
    expect(where(moveLine(at(0, 20), -1, 316))).toEqual([0, 14]);
  });
});

describe("locating the caret", () => {
  it("starts on the last line fully inside the viewport", () => {
    const position = lastVisibleLine(content, {
      top: 0,
      bottom: 135,
      left: 80,
      right: 600,
    });
    expect(position && where(position)).toEqual([1, 11]);
  });

  it("finds an item again by its distance from the end after a remount", () => {
    const stale = document.createElement("div");
    const position = locate(content, {
      item: stale,
      index: 5,
      after: false,
      fromEnd: 2,
    });
    expect(position && where(position)).toEqual([0, 5]);
    expect(position && caretPoint(position)).toEqual({
      node: content.querySelector(".ev-text")!.firstChild,
      offset: 5,
    });
  });
});

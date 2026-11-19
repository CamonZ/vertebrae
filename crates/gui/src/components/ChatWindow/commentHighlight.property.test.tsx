import { act, cleanup, render } from "@testing-library/react";
import { useRef } from "react";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import * as hegel from "@hegeldev/hegel";
import * as gs from "@hegeldev/hegel/generators";
import type { TestCase } from "@hegeldev/hegel";
import {
  ACTIVE_HIGHLIGHT,
  PENDING_HIGHLIGHT,
  findQuoteRange,
  useCommentHighlights,
} from "./commentHighlight";
import type { PendingTextComment } from "./assistantTextComments";

/*
 * Invariants of the transcript highlight that ties a composer chip to the
 * text it comments on (ticket 3845ab6b):
 *
 * - A quote is found despite whitespace differences between the browser's
 *   selection text and the rendered DOM, and the range covers exactly it.
 * - When the captured context identifies one occurrence, that one is chosen.
 * - Every mounted transcript contributes its comments; the active comment is
 *   in the active highlight only, the others in the pending one, and an
 *   unmounted transcript leaves nothing behind.
 */

const WORDS = ["alpha", "beta", "the", "parser", "x", "(a)", "ok."];
const strip = (text: string) => text.replace(/\s+/g, "");

/**
 * A rendered response: words in text nodes, some wrapped in inline or block
 * elements, with whitespace text between some of them.
 */
function drawResponse(tc: TestCase, id: string): HTMLElement {
  const response = document.createElement("div");
  response.dataset.localChatAssistantResponseId = id;
  const count = tc.draw(gs.integers({ minValue: 1, maxValue: 30 }));
  for (let index = 0; index < count; index++) {
    const word = tc.draw(gs.sampledFrom(WORDS));
    const wrap = tc.draw(gs.sampledFrom(["", "", "strong", "code", "p", "li"]));
    const node = wrap ? document.createElement(wrap) : null;
    if (node) node.textContent = word;
    response.append(node ?? document.createTextNode(word));
    const gap = tc.draw(gs.sampledFrom(["", " ", "\n", "  "]));
    if (gap) response.append(document.createTextNode(gap));
  }
  return response;
}

/** A selection captured from `text`, its whitespace as the browser reports. */
function drawCapture(tc: TestCase, text: string) {
  const start = tc.draw(
    gs.integers({ minValue: 0, maxValue: text.length - 1 })
  );
  const end = tc.draw(
    gs.integers({ minValue: start + 1, maxValue: text.length })
  );
  const reflow = (part: string) =>
    part.replace(/\s+/g, () => tc.draw(gs.sampledFrom([" ", "\n", "\n\n"])));
  return {
    start,
    end,
    quote: reflow(text.slice(start, end)),
    contextBefore: reflow(text.slice(Math.max(0, start - 80), start)),
    contextAfter: reflow(text.slice(end, end + 80)),
  };
}

/** Index among non-whitespace characters of `text` up to `offset`. */
const denseIndex = (text: string, offset: number) =>
  strip(text.slice(0, offset)).length;

function occurrences(text: string, part: string): number[] {
  const found = [];
  for (let at = text.indexOf(part); at >= 0; at = text.indexOf(part, at + 1))
    found.push(at);
  return found;
}

describe("findQuoteRange", () => {
  test("covers exactly the quote, at the occurrence the context identifies", () =>
    hegel.test(
      (tc) => {
        const root = document.createElement("div");
        const response = drawResponse(tc, "r1");
        root.append(response);
        document.body.append(root);
        try {
          const text = response.textContent ?? "";
          tc.assume(strip(text).length > 0);
          const capture = drawCapture(tc, text);
          tc.assume(strip(capture.quote).length > 0);

          const range = findQuoteRange(root, {
            responseId: "r1",
            ...capture,
          });
          expect(range).not.toBeNull();
          expect(strip(range!.toString())).toBe(strip(capture.quote));
          expect(response.contains(range!.commonAncestorContainer)).toBe(true);

          // Independent oracle: if quote plus its full captured context is
          // unique in the dense text, the range starts at the captured spot.
          const dense = strip(text);
          const window =
            strip(capture.contextBefore) +
            strip(capture.quote) +
            strip(capture.contextAfter);
          const hits = occurrences(dense, window);
          if (hits.length === 1) {
            const prefix = document.createRange();
            prefix.selectNodeContents(response);
            prefix.setEnd(range!.startContainer, range!.startOffset);
            expect(strip(prefix.toString()).length).toBe(
              denseIndex(text, capture.start)
            );
          }
        } finally {
          root.remove();
        }
      },
      { testCases: 300 }
    ));

  test("finds nothing in another response", () =>
    hegel.test((tc) => {
      const root = document.createElement("div");
      root.append(drawResponse(tc, "r1"));
      try {
        const text = root.textContent ?? "";
        tc.assume(strip(text).length > 0);
        const capture = drawCapture(tc, text);
        expect(findQuoteRange(root, { responseId: "r2", ...capture })).toBe(
          null
        );
      } finally {
        root.remove();
      }
    }));
});

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

const RESPONSE_TEXT = ["alpha beta", "the parser", "x (a) ok."];

function Pane({
  comments,
  activeId,
}: {
  comments: PendingTextComment[];
  activeId: string | null;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useCommentHighlights(ref, comments, activeId, comments);
  return (
    <div ref={ref}>
      {RESPONSE_TEXT.map((text, index) => (
        <div key={index} data-local-chat-assistant-response-id={`r${index}`}>
          <p>{text}</p>
        </div>
      ))}
    </div>
  );
}

interface PaneModel {
  comments: PendingTextComment[];
  activeId: string | null;
  view: ReturnType<typeof render> | null;
}
interface Machine {
  panes: PaneModel[];
  next: number;
}

const QUOTES = [
  { responseId: "r0", quote: "beta" },
  { responseId: "r1", quote: "the parser" },
  { responseId: "r2", quote: "(a)" },
  // Not in the transcript: never highlighted.
  { responseId: "r1", quote: "missing" },
];

function show(pane: PaneModel) {
  const element = <Pane comments={pane.comments} activeId={pane.activeId} />;
  act(() => {
    if (pane.view) pane.view.rerender(element);
    else pane.view = render(element);
  });
}

const drawPane = (tc: TestCase, machine: Machine) =>
  machine.panes[tc.draw(gs.integers({ minValue: 0, maxValue: 1 }))];

const highlightMachine: hegel.stateful.StateMachine<Machine> = {
  rules: {
    add: (tc, machine) => {
      const pane = drawPane(tc, machine);
      const quote = tc.draw(gs.sampledFrom(QUOTES));
      pane.comments = [
        ...pane.comments,
        {
          kind: "text",
          id: `c${machine.next++}`,
          itemId: null,
          contextBefore: "",
          contextAfter: "",
          body: "b",
          ...quote,
        },
      ];
      if (pane.view) show(pane);
    },
    remove: (tc, machine) => {
      const pane = drawPane(tc, machine);
      tc.assume(pane.comments.length > 0);
      const index = tc.draw(
        gs.integers({ minValue: 0, maxValue: pane.comments.length - 1 })
      );
      pane.comments = pane.comments.filter((_, at) => at !== index);
      if (pane.view) show(pane);
    },
    activate: (tc, machine) => {
      const pane = drawPane(tc, machine);
      const ids = [null, ...pane.comments.map((comment) => comment.id)];
      pane.activeId = tc.draw(gs.sampledFrom(ids));
      if (pane.view) show(pane);
    },
    mount: (tc, machine) => {
      const pane = drawPane(tc, machine);
      tc.assume(pane.view === null);
      show(pane);
    },
    unmount: (tc, machine) => {
      const pane = drawPane(tc, machine);
      tc.assume(pane.view !== null);
      act(() => pane.view!.unmount());
      pane.view = null;
    },
  },
  invariants: {
    highlightsMatchMountedPanes: {
      alwaysCheck: true,
      check: (_tc, machine) => {
        const expected = { pending: [] as string[], active: [] as string[] };
        for (const pane of machine.panes) {
          if (!pane.view) continue;
          for (const comment of pane.comments) {
            if (comment.quote === "missing") continue;
            (comment.id === pane.activeId
              ? expected.active
              : expected.pending
            ).push(comment.quote);
          }
        }
        const actual = (name: string) =>
          [...(registry.get(name) ?? [])].map((range) => range.toString());
        expect(actual(PENDING_HIGHLIGHT).sort()).toEqual(
          expected.pending.sort()
        );
        expect(actual(ACTIVE_HIGHLIGHT).sort()).toEqual(expected.active.sort());
      },
    },
  },
};

test("split panes each contribute their comments, and the active one only once", () =>
  hegel.test(
    (tc) => {
      const machine: Machine = {
        next: 0,
        panes: [0, 1].map(() => ({ comments: [], activeId: null, view: null })),
      };
      try {
        hegel.stateful.run(tc, highlightMachine, machine, { stepCount: 30 });
      } finally {
        for (const pane of machine.panes) pane.view?.unmount();
        cleanup();
      }
    },
    { testCases: 60 }
  ));

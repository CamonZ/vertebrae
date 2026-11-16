import { cleanup, render } from "@testing-library/react";
import { describe, expect, test } from "vitest";
import * as hegel from "@hegeldev/hegel";
import * as gs from "@hegeldev/hegel/generators";
import type { TestCase } from "@hegeldev/hegel";
import { MarkdownContent } from "../shared/MarkdownContent";
import {
  formatTextCommentsForReply,
  replyHunk,
  type PendingDiffComment,
  type PendingTextComment,
} from "./assistantTextComments";
import { createDiffComment } from "../thread/toolChange/diffComments";
import {
  findRow,
  parsePatch,
  resolveSelection,
  spanRows,
  type HunkRow,
} from "../thread/toolChange/diffLineMapper";
import { filePatch } from "../thread/toolChange/diffPatchBuilder.test.helpers";
import { drawSelectionPoint } from "../thread/toolChange/diffScenario.test.helpers";

/*
 * Invariants of the outbound reply message (ticket 3845ab6b).
 *
 * Text comments: the quoted context + selection + context is one Markdown
 * blockquote, however many lines the selection has; every selection line is
 * bold; context is a suffix/prefix of what was captured; the reply follows
 * outside the quote, without a "Comment:" prefix.
 *
 * Diff comments: the hunk sent is the stored hunk cut to the selection plus
 * up to three rows before it, with a header that numbers every row as the
 * stored hunk does; each selected line reaches the agent once (no separate
 * code snapshot); the stored hunk is never modified.
 */

// Rendered DOM text: no Markdown syntax, but punctuation and line breaks.
const WORDS = ["alpha", "beta", "parser", "x1", "é", "(a)", "tests.", "f()"];
const BREAKS = [" ", " ", "  ", "\t", "\n", "\n\n", "\r\n"];

/**
 * A rendered paragraph and a selection in it, captured the way
 * `textSelectionToAnchor` does: the quote is any slice (it may start or end
 * mid-word) and the context is up to 80 characters on each side.
 */
function drawSelection(tc: TestCase) {
  const words = tc.draw(
    gs.arrays(gs.sampledFrom(WORDS), { minSize: 1, maxSize: 40 })
  );
  const text = words
    .map((word) => word + tc.draw(gs.sampledFrom(BREAKS)))
    .join("");
  const start = tc.draw(
    gs.integers({ minValue: 0, maxValue: text.length - 1 })
  );
  const end = tc.draw(
    gs.integers({ minValue: start + 1, maxValue: text.length })
  );
  return {
    quote: text.slice(start, end),
    contextBefore: text.slice(Math.max(0, start - 80), start),
    contextAfter: text.slice(end, end + 80),
  };
}

const strip = (text: string) => text.replace(/\s+/g, "");
const collapse = (text: string) => text.replace(/\s+/g, " ").trim();

/** Rendered text of a node, ignoring the cut marker. */
const plain = (node: Node | null) =>
  strip(node?.textContent ?? "").replace(/…/g, "");

/** Text in `root` before (or after) its first (or last) <strong>. */
function textOutside(root: Element, edge: "before" | "after"): string {
  const strongs = root.querySelectorAll("strong");
  const range = document.createRange();
  range.selectNodeContents(root);
  if (edge === "before") range.setEndBefore(strongs[0]);
  else range.setStartAfter(strongs[strongs.length - 1]);
  return strip(range.toString()).replace(/…/g, "");
}

describe("text comment reply", () => {
  test("quotes context and selection as one blockquote and puts the reply after it", () =>
    hegel.test(
      (tc) => {
        const selection = drawSelection(tc);
        const { quote } = selection;
        // An all-whitespace selection never becomes a comment.
        tc.assume(quote.trim().length > 0);
        const comment: PendingTextComment = {
          kind: "text",
          id: "c",
          responseId: "r",
          itemId: null,
          ...selection,
          body: tc.draw(
            gs.sampledFrom([
              "",
              "  ",
              "Why?",
              "Why this?\nAnd that?",
              "Fix\n\nit",
            ])
          ),
        };
        const message = formatTextCommentsForReply([comment], "");
        expect(message).not.toContain("Comment:");

        // The oracle is the app's own Markdown renderer, not the formatter.
        const { container } = render(<MarkdownContent text={message} />);
        try {
          const items = container.querySelectorAll("ol > li");
          expect(items).toHaveLength(1);
          const item = items[0];
          const quotes = item.querySelectorAll(":scope > blockquote");
          expect(quotes).toHaveLength(1);
          const blockquote = quotes[0];

          // The whole selection is inside the quote, every line bold.
          expect(plain(blockquote)).toContain(strip(quote));
          const boldLines = quote.split(/\r?\n/).map(collapse).filter(Boolean);
          const strong = [...blockquote.querySelectorAll("strong")].map(
            (element) => collapse(element.textContent ?? "")
          );
          expect(strong).toEqual(boldLines);

          // Context is what was captured, trimmed only at the cut ends.
          const before = textOutside(blockquote, "before");
          const after = textOutside(blockquote, "after");
          expect(strip(comment.contextBefore).endsWith(before)).toBe(true);
          expect(strip(comment.contextAfter).startsWith(after)).toBe(true);
          if (comment.contextBefore.length < 80)
            expect(before).toBe(strip(comment.contextBefore));
          if (comment.contextAfter.length < 80)
            expect(after).toBe(strip(comment.contextAfter));

          // The reply is plain text after the quote, never inside it.
          const rest = [...item.children].filter(
            (child) =>
              child.compareDocumentPosition(blockquote) &
              Node.DOCUMENT_POSITION_PRECEDING
          );
          expect(strip(rest.map((node) => node.textContent).join(""))).toBe(
            strip(comment.body)
          );
          expect(rest.every((node) => node.tagName !== "BLOCKQUOTE")).toBe(
            true
          );
        } finally {
          cleanup();
        }
      },
      { testCases: 150 }
    ));
});

interface Row {
  kind: HunkRow["kind"];
  text: string;
  oldLine: number | null;
  newLine: number | null;
  noNewline: boolean;
}
const rowFacts = ({
  kind,
  text,
  oldLine,
  newLine,
  noNewline,
}: HunkRow): Row => ({
  kind,
  text,
  oldLine,
  newLine,
  noNewline,
});

/** A file with unique lines, random edits and random context width. */
function drawFile(tc: TestCase) {
  const size = tc.draw(gs.integers({ minValue: 1, maxValue: 30 }));
  const before = Array.from({ length: size }, (_, index) => `line ${index}`);
  let next = 1000;
  const after = [...before];
  const edits = tc.draw(gs.integers({ minValue: 1, maxValue: 4 }));
  for (let edit = 0; edit < edits; edit++) {
    if (after.length && tc.draw(gs.booleans()))
      after.splice(
        tc.draw(gs.integers({ minValue: 0, maxValue: after.length - 1 })),
        tc.draw(gs.integers({ minValue: 1, maxValue: 3 }))
      );
    else
      after.splice(
        tc.draw(gs.integers({ minValue: 0, maxValue: after.length })),
        0,
        ...Array.from(
          { length: tc.draw(gs.integers({ minValue: 1, maxValue: 3 })) },
          () => `line ${next++}`
        )
      );
  }
  const patch = filePatch({
    path: "f.ts",
    before,
    after,
    context: tc.draw(gs.integers({ minValue: 0, maxValue: 8 })),
  });
  return parsePatch(patch)[0] ?? null;
}

function drawDiffComment(tc: TestCase) {
  const file = drawFile(tc);
  tc.assume(file !== null && file.hunks.length > 0);
  const a = drawSelectionPoint(tc, file!)!;
  const b = drawSelectionPoint(tc, file!)!;
  const span = resolveSelection(file!, a.point, b.point)!;
  const comment = createDiffComment({
    id: "c",
    body: tc.draw(gs.sampledFrom(["", "Why?", "Why\nthis?"])),
    home: { kind: "worktree", wholeBranch: false },
    file: file!,
    span,
  })!;
  const attach = tc.draw(gs.booleans());
  const code = spanRows(file!, span)!
    .map((row) => row.text)
    .join("\n");
  return {
    file: file!,
    comment: attach ? { ...comment, selectionCode: code } : comment,
  };
}

/** The rows of the first ```diff block in `message`, parsed. */
function sentRows(message: string): Row[] {
  const lines = message.split("\n");
  const open = lines.findIndex((line) => line.trim() === "```diff");
  const close = lines.findIndex(
    (line, index) => index > open && line.trim() === "```"
  );
  const body = lines.slice(open + 1, close).map((line) => line.slice(3));
  const parsed = parsePatch(["--- a/f.ts", "+++ b/f.ts", ...body].join("\n"));
  return parsed[0].hunks.flatMap((hunk) => hunk.rows.map(rowFacts));
}

describe("diff comment reply", () => {
  test("sends the selection and up to three rows before it, numbered as in the patch", () =>
    hegel.test(
      (tc) => {
        const { file, comment } = drawDiffComment(tc);
        const stored = comment.hunk;
        const message = formatTextCommentsForReply([comment], "Follow");

        // Independent expectation from the parsed patch, not the formatter.
        const end = findRow(file, comment.side, comment.endLine)!;
        const rows = end.hunk.rows;
        const first = rows.findIndex((row) =>
          comment.side === "old"
            ? row.kind !== "add" && row.oldLine === comment.startLine
            : row.kind !== "del" && row.newLine === comment.startLine
        );
        const expected = rows
          .slice(Math.max(0, first - 3), end.rowIndex + 1)
          .map(rowFacts);

        expect(sentRows(message)).toEqual(expected);
        expect(comment.hunk).toBe(stored);

        // Every row text is unique, so each sent row appears exactly once:
        // no second copy of the code outside the diff block.
        for (const row of expected) {
          const count =
            message.split(new RegExp(`${row.text}(?!\\d)`)).length - 1;
          expect(count, row.text).toBe(1);
        }
        expect(message).not.toContain("Selected code snapshot");
        expect(message).not.toContain("Comment:");
        if (comment.body.trim())
          expect(message).toContain(
            `\`\`\`\n\n${comment.body
              .trim()
              .split("\n")
              .map((line) => (line ? `   ${line}` : ""))
              .join("\n")}`
          );
      },
      { testCases: 300 }
    ));

  test("trimming is idempotent and keeps a hunk it cannot place", () =>
    hegel.test((tc) => {
      const { comment } = drawDiffComment(tc);
      const once = replyHunk(comment);
      expect(replyHunk({ ...comment, hunk: once })).toBe(once);
      const broken: PendingDiffComment = { ...comment, hunk: "no header" };
      expect(replyHunk(broken)).toBe("no header");
    }));
});

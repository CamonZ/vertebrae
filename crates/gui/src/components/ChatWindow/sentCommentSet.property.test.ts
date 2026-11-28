import { describe, expect, test } from "vitest";
import * as hegel from "@hegeldev/hegel";
import * as gs from "@hegeldev/hegel/generators";
import type { TestCase } from "@hegeldev/hegel";
import {
  formatTextCommentsForReply,
  replyHunk,
  type DiffCommentHome,
  type PendingComment,
  type PendingDiffComment,
  type PendingGithubThreadComment,
  type PendingTextComment,
} from "./assistantTextComments";
import { parseSentComments } from "./sentCommentSet";

/*
 * The user turn reads its comment cards back out of the exact text the
 * agent received (ticket 5c3802ae). Reading never changes the payload, so
 * the invariant is a round trip: every message formatTextCommentsForReply
 * produces parses into the same comments, in order, with the same bodies,
 * locations, hunks and follow-up; anything else renders as plain text.
 */

const WORDS = ["alpha", "beta", "parser", "x1", "é", "(a)", "tests.", "f()"];
const BREAKS = [" ", " ", "  ", "\n"];
const BODIES = [
  "",
  "Why?",
  "Why this?\nAnd that?",
  "Fix\n\nit",
  "1. not an entry",
  "Follow-up:\nstill the body",
  "**bold** reply",
];
const FOLLOW_UPS = ["", "  ", "Thanks", "Two\n\nparagraphs", "2. listy"];

const strip = (text: string) => text.replace(/\s+/g, "").replace(/…/g, "");

function drawWords(tc: TestCase, max: number): string {
  const words = tc.draw(
    gs.arrays(gs.sampledFrom(WORDS), { minSize: 1, maxSize: max })
  );
  return words.map((word) => word + tc.draw(gs.sampledFrom(BREAKS))).join("");
}

function drawText(tc: TestCase, id: string): PendingTextComment {
  const text = drawWords(tc, 30);
  const start = tc.draw(
    gs.integers({ minValue: 0, maxValue: text.length - 1 })
  );
  const end = tc.draw(
    gs.integers({ minValue: start + 1, maxValue: text.length })
  );
  return {
    kind: "text",
    id,
    responseId: "r",
    itemId: null,
    quote: text.slice(start, end),
    contextBefore: text.slice(Math.max(0, start - 80), start),
    contextAfter: text.slice(end, end + 80),
    body: tc.draw(gs.sampledFrom(BODIES)),
  };
}

function drawDiff(tc: TestCase, id: string): PendingDiffComment {
  const start = tc.draw(gs.integers({ minValue: 1, maxValue: 400 }));
  const span = tc.draw(gs.integers({ minValue: 0, maxValue: 3 }));
  const rows = Array.from(
    { length: span + 1 },
    (_, index) =>
      `${tc.draw(gs.sampledFrom([" ", "+"]))}row ${index} ${tc.draw(
        gs.sampledFrom(["", "`x`", "```", "**"])
      )}`
  );
  return {
    kind: "diff",
    id,
    body: tc.draw(gs.sampledFrom(BODIES)),
    home: tc.draw(
      gs.sampledFrom<DiffCommentHome>([
        { kind: "worktree", wholeBranch: false } as const,
        { kind: "tool_call", toolUseId: "t", toolName: "Edit" } as const,
        { kind: "tool_call", toolUseId: "t" } as const,
      ])
    ),
    path: tc.draw(gs.sampledFrom(["src/a.ts", "dir with space/b.rs", "c"])),
    side: "new",
    startLine: start,
    endLine: start + span,
    hunk: [`@@ -${start},${span + 1} +${start},${span + 1} @@`, ...rows].join(
      "\n"
    ),
    outdated: tc.draw(gs.booleans()),
  };
}

/** A GitHub thread and its private discussion, as Send to main chat attaches it. */
function drawGithub(tc: TestCase, id: string): PendingGithubThreadComment {
  const start = tc.draw(gs.integers({ minValue: 1, maxValue: 400 }));
  const span = tc.draw(gs.integers({ minValue: 0, maxValue: 3 }));
  const code = Array.from(
    { length: span + 1 },
    (_, index) =>
      `${tc.draw(gs.sampledFrom(["", "  ", "\t"]))}line ${index}${tc.draw(
        gs.sampledFrom(["", "`x`", "```", "**", " // > quoted"])
      )}`
  ).join("\n");
  const who = gs.sampledFrom(["alice", "bob-2", "carol_c"]);
  // Sent without a discussion, a thread may have no lines (a file-level
  // comment) or no code read for them.
  const discussed = tc.draw(gs.booleans());
  const lines = discussed || tc.draw(gs.booleans());
  return {
    kind: "github_thread",
    id,
    body: tc.draw(gs.sampledFrom(BODIES)),
    githubThreadId: `PRRT_${id}`,
    discussionId: discussed ? `d-${id}` : null,
    path: tc.draw(gs.sampledFrom(["src/a.ts", "dir with space/b.rs", "c"])),
    side: tc.draw(gs.sampledFrom<"new" | "old">(["new", "old"])),
    startLine: lines ? start : null,
    endLine: lines ? start + span : null,
    code: discussed || tc.draw(gs.booleans()) ? code : "",
    author: tc.draw(gs.optional(who)) ?? null,
    comments: tc.draw(
      gs.arrays(
        gs.tuples(who, gs.sampledFrom(BODIES)).map(([author, body]) => ({
          author,
          body,
        })),
        { maxSize: 3 }
      )
    ),
    turns: !discussed
      ? []
      : tc.draw(
          gs.arrays(
            gs
              .tuples(
                gs.sampledFrom<"user" | "assistant">(["user", "assistant"]),
                gs.sampledFrom(BODIES.filter(Boolean))
              )
              .map(([role, text]) => ({ role, text })),
            { maxSize: 3 }
          )
        ),
  };
}

describe("sent comment set", () => {
  test("parses every formatted message back into its comments", () =>
    hegel.test(
      (tc) => {
        const count = tc.draw(gs.integers({ minValue: 1, maxValue: 4 }));
        const comments: PendingComment[] = Array.from(
          { length: count },
          (_, index) => {
            const kind = tc.draw(
              gs.sampledFrom(["text", "diff", "github_thread"] as const)
            );
            return kind === "text"
              ? drawText(tc, `c${index}`)
              : kind === "diff"
                ? drawDiff(tc, `c${index}`)
                : drawGithub(tc, `c${index}`);
          }
        );
        for (const comment of comments)
          if (comment.kind === "text") tc.assume(comment.quote.trim() !== "");
        const followUp = tc.draw(gs.sampledFrom(FOLLOW_UPS));

        const message = formatTextCommentsForReply(comments, followUp);
        const set = parseSentComments(message);
        expect(set).not.toBeNull();
        expect(message.startsWith(`${set!.heading}:`)).toBe(true);
        expect(set!.followUp).toBe(followUp.trim());
        expect(set!.comments).toHaveLength(comments.length);

        set!.comments.forEach((sent, index) => {
          const comment = comments[index];
          expect(sent.number).toBe(index + 1);
          if (comment.kind === "github_thread") {
            // Read back as a code comment: its heading, code and the thread,
            // discussion and note as the text, in that order.
            expect(sent).toMatchObject({
              kind: "diff",
              home:
                comment.author === null
                  ? "GitHub thread"
                  : `GitHub thread from ${comment.author}`,
              path: comment.path,
              startLine: comment.startLine,
              endLine: comment.endLine,
              side: comment.side,
              outdated: false,
              hunk: comment.code,
            });
            const parts = [
              ...comment.comments.map(({ author }) => `**${author}:**`),
              ...comment.turns.map(({ role }) =>
                role === "user" ? "**You:**" : "**Assistant:**"
              ),
              comment.body.trim(),
            ];
            let from = 0;
            for (const part of parts) {
              const at = sent.body.indexOf(part, from);
              expect(at).toBeGreaterThanOrEqual(0);
              from = at + part.length;
            }
            if (comment.body.trim())
              expect(sent.body.endsWith(comment.body.trim())).toBe(true);
            return;
          }
          expect(sent.kind).toBe(comment.kind);
          expect(sent.body).toBe(comment.body.trim());
          if (comment.kind === "diff" && sent.kind === "diff") {
            expect(sent).toMatchObject({
              path: comment.path,
              startLine: comment.startLine,
              endLine: comment.endLine,
              side: comment.side,
              outdated: comment.outdated,
              hunk: replyHunk(comment),
            });
          } else if (comment.kind === "text" && sent.kind === "text") {
            expect(strip(sent.selection)).toBe(strip(comment.quote));
            expect(
              strip(comment.contextBefore).endsWith(strip(sent.contextBefore))
            ).toBe(true);
            expect(
              strip(comment.contextAfter).startsWith(strip(sent.contextAfter))
            ).toBe(true);
          }
        });
      },
      { testCases: 200 }
    ));

  test("leaves text that is not a comment set to plain rendering", () => {
    const message = formatTextCommentsForReply(
      [
        {
          kind: "text",
          id: "c",
          responseId: "r",
          itemId: null,
          quote: "beta",
          contextBefore: "alpha ",
          contextAfter: " gamma",
          body: "Why?",
        },
      ],
      "Thanks"
    );
    expect(parseSentComments(message)).not.toBeNull();
    for (const text of [
      "",
      "Hello there",
      "Comments on the previous response:\n\n",
      message.replace("1. ", "2. "),
      message.replace("   > ", "> "),
      `${message.split("\n\nFollow-up:")[0]}\n\nFollow-up:\n  `,
      `Quoted: ${message}`,
    ])
      expect(parseSentComments(text)).toBeNull();
  });
});

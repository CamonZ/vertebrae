import { describe, expect, test } from "vitest";
import * as hegel from "@hegeldev/hegel";
import * as gs from "@hegeldev/hegel/generators";
import type {
  ComparisonSnapshot,
  GithubThreadPlacement,
} from "../../../../bindings";
import type { ChatMessage } from "../../../../stores/chatStore";
import { reviewLocation, reviewRange } from "../../reviewAnchors";
import type { CodeSelection } from "../../selectionDiscussions";
import { at, reviewThread } from "./fixture";
import {
  canDiscussGithub,
  discussionTurns,
  githubDiscussionAnchor,
  githubDiscussionTarget,
  githubThreadAttachment,
  githubThreadPlace,
} from "./githubDiscussion";
import { buildReviewModel } from "./model";

/*
 * A GitHub thread's private discussion captures the lines the thread is
 * commented on (3e4d738d). Oracle: on unchanged lines, that is exactly
 * what a selection of the same lines in the same comparison captures
 * (`reviewLocation`); lines edited locally are read at their published
 * range from the published commit, and an outdated thread from the commit
 * its snippet came from; an unverified thread (its commit not fetched) and
 * the rest have no lines to capture, and the card offers Discuss inline
 * exactly when there are some.
 */

const COMMIT = (digit: string) => digit.repeat(40);
const line = gs.integers({ minValue: 1, maxValue: 400 });
const span = gs.integers({ minValue: 0, maxValue: 3 });

const placements = gs.oneOf<GithubThreadPlacement>(
  gs.tuples(line, span, line).map(([end, width, published]) => ({
    kind: "anchored",
    startLine: Math.max(1, end - width),
    line: end,
    publishedLine: published,
  })),
  gs.tuples(line, span).map(([end, width]): GithubThreadPlacement => {
    const startLine = Math.max(1, end - width);
    // The published lines with a line of context on each side.
    const published = Array.from(
      { length: end - startLine + 3 },
      (_, index) => startLine - 1 + index
    )
      .filter((number) => number >= 1)
      .map((number) => ({
        number,
        text: `published ${number}`,
        focus: startLine <= number && number <= end,
      }));
    return {
      kind: "edited",
      startLine,
      line: end,
      published,
      editedLines: [end],
      publishedCommit: COMMIT("4"),
    };
  }),
  gs.tuples(line, span).map(([end, width]) => ({
    kind: "unverified",
    startLine: Math.max(1, end - width),
    line: end,
  })),
  gs
    .tuples(gs.optional(line), span, gs.booleans())
    .map(([end, width, local]): GithubThreadPlacement => {
      const read = end !== null && end !== undefined && local;
      return {
        kind: "outdated",
        originalStartLine: end == null ? null : Math.max(1, end - width),
        originalLine: end ?? null,
        original: read
          ? [{ number: end, text: "let x = 0;", focus: true }]
          : [],
        originalCommit: read ? COMMIT("3") : null,
      };
    }),
  gs.sampledFrom<GithubThreadPlacement>([
    { kind: "file_level" },
    { kind: "not_shown" },
    { kind: "unplaceable", reason: "invalid_anchor" },
    { kind: "unplaceable", reason: "unreadable" },
  ])
);

const comparisons = gs.tuples(gs.booleans(), gs.booleans()).map(
  ([workingTree, mergeBase]): ComparisonSnapshot => ({
    base_commit: COMMIT("a"),
    selected_base_commit: COMMIT("a"),
    target_commit: COMMIT("b"),
    working_tree: workingTree,
    merge_base: mergeBase,
  })
);

describe("GitHub thread discussion target", () => {
  test("captures what a selection of the drawn lines would, or nothing", () =>
    hegel.test(
      (tc) => {
        const side = tc.draw(gs.sampledFrom(["LEFT", "RIGHT"] as const));
        const path = tc.draw(gs.sampledFrom(["src/lib.rs", "a b/c.ts"]));
        const thread = reviewThread("PRRT_1", { path, side });
        const placement = tc.draw(placements);
        const comparison = tc.draw(comparisons);
        const placed = buildReviewModel(
          7,
          [thread],
          [at(thread.id, placement)],
          false
        ).byThread.get(thread.id)!;

        const target = githubDiscussionTarget(placed, comparison);
        expect(canDiscussGithub(placed)).toBe(target !== null);

        switch (placed.kind) {
          case "line": {
            if (placed.drift.kind === "unverified") {
              expect(target).toBeNull();
              break;
            }
            if (placed.drift.kind === "edited") {
              expect(target).toEqual({
                githubThreadId: thread.id,
                location: {
                  path,
                  side,
                  source: { kind: "worktree", commit: placed.drift.commit },
                },
                range: { startLine: placed.startLine, line: placed.line },
              });
              break;
            }
            const selection: CodeSelection = {
              path,
              side: side === "LEFT" ? "old" : "new",
              startLine: placed.startLine,
              endLine: placed.line,
              code: "",
              file: { oldPath: path, newPath: path, hunks: [] },
              home: { kind: "worktree", wholeBranch: false },
            };
            expect(target).toEqual({
              githubThreadId: thread.id,
              location: reviewLocation(selection, "chat", comparison),
              range: reviewRange(selection),
            });
            // Its anchor labels the same lines.
            const anchor = githubDiscussionAnchor(target!, "code", null);
            expect(reviewRange(anchor)).toEqual(target!.range);
            expect(anchor.side).toBe(selection.side);
            break;
          }
          case "outdated":
            if (placed.originalCommit === null || placed.originalLine === null)
              expect(target).toBeNull();
            else
              expect(target).toEqual({
                githubThreadId: thread.id,
                location: {
                  path,
                  side,
                  source: { kind: "worktree", commit: placed.originalCommit },
                },
                range: {
                  startLine: placed.originalStartLine ?? placed.originalLine,
                  line: placed.originalLine,
                },
              });
            break;
          case "file":
          case "unplaceable":
            expect(target).toBeNull();
        }
      },
      { testCases: 300 }
    ));

  test("sends a thread without a discussion at its drawn lines, else GitHub's", () =>
    hegel.test(
      (tc) => {
        const side = tc.draw(gs.sampledFrom(["LEFT", "RIGHT"] as const));
        const fileLevel = tc.draw(gs.booleans());
        const anchorLine = tc.draw(gs.optional(line)) ?? null;
        const thread = reviewThread("PRRT_1", {
          side,
          fileLevel,
          line: fileLevel ? null : anchorLine,
          startLine: null,
          originalLine: fileLevel ? null : 9,
        });
        const placed = buildReviewModel(
          7,
          [thread],
          [at(thread.id, tc.draw(placements))],
          false
        ).byThread.get(thread.id)!;
        const comparison = tc.draw(gs.optional(comparisons)) ?? null;

        const place = githubThreadPlace(placed, comparison, null);
        const target = comparison && githubDiscussionTarget(placed, comparison);
        expect(place.path).toBe(thread.anchor.path);
        expect(place.side).toBe(side === "LEFT" ? "old" : "new");
        if (target) {
          // The lines a discussion would capture, with the code read for them.
          expect([place.startLine, place.endLine]).toEqual([
            target.range.startLine,
            target.range.line,
          ]);
          const snippet =
            placed.kind === "outdated"
              ? placed.original
              : placed.kind === "line" && placed.drift.kind === "edited"
                ? placed.published
                : null;
          expect(place.code).toBe(
            snippet
              ? snippet
                  .filter(
                    ({ number }) =>
                      target.range.startLine <= number &&
                      number <= target.range.line
                  )
                  .map(({ text }) => text)
                  .join("\n")
              : ""
          );
        } else {
          // GitHub's own lines, without code; a file-level comment has none.
          const end = fileLevel ? null : (anchorLine ?? 9);
          expect(place).toMatchObject({
            startLine: end,
            endLine: end,
            code: "",
          });
        }

        const sent = githubThreadAttachment(
          thread.id,
          thread,
          place,
          null,
          "a"
        );
        expect(sent).toMatchObject({
          githubThreadId: thread.id,
          discussionId: null,
          turns: [],
          author: "alice",
          ...place,
        });
      },
      { testCases: 300 }
    ));

  test("attaches the questions and replies of the discussion, in order", () =>
    hegel.test(
      (tc) => {
        const messages = tc.draw(
          gs.arrays(
            gs.oneOf<ChatMessage>(
              gs
                .sampledFrom(["why?", "  ", "and?"])
                .map((text) => ({ kind: "user", text, timestamp: "t" })),
              gs
                .tuples(gs.sampledFrom(["because", ""]), gs.booleans())
                .map(([text, child]) => ({
                  kind: "assistant",
                  text,
                  timestamp: "t",
                  ...(child ? { parentToolUseId: "task" } : {}),
                })),
              gs.just<ChatMessage>({
                kind: "tool_call",
                toolName: "Read",
                toolId: "r",
                input: "{}",
                timestamp: "t",
              })
            ),
            { maxSize: 8 }
          )
        );
        const expected = messages.flatMap((message) =>
          message.kind === "user" ||
          (message.kind === "assistant" && !message.parentToolUseId)
            ? message.text.trim()
              ? [{ role: message.kind, text: message.text }]
              : []
            : []
        );
        expect(discussionTurns(messages)).toEqual(expected);
      },
      { testCases: 200 }
    ));
});

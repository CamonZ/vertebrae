import { describe, expect, it } from "vitest";
import {
  formatTextCommentsForReply,
  textSelectionToAnchor,
  type PendingDiffComment,
  type PendingTextComment,
} from "./assistantTextComments";

function selectText(text: string, start: number, end: number): Selection {
  const node = document.createTextNode(text);
  const paragraph = document.createElement("p");
  paragraph.append(node);
  const response = document.createElement("div");
  response.dataset.localChatAssistantResponseId = "response-item-7";
  response.dataset.localChatAssistantItemId = "item-7";
  response.append(paragraph);
  const transcript = document.createElement("main");
  transcript.append(response);
  document.body.append(transcript);

  const range = document.createRange();
  range.setStart(node, start);
  range.setEnd(node, end);
  const selection = window.getSelection();
  selection?.removeAllRanges();
  selection?.addRange(range);
  return selection!;
}

describe("assistant text comments", () => {
  it("captures the exact quote, item identity, and nearby rendered context", () => {
    const selection = selectText(
      "Read this carefully, then update the parser.",
      10,
      19
    );
    const transcript = document.querySelector("main") as HTMLElement;

    expect(textSelectionToAnchor(selection, transcript)).toEqual({
      responseId: "response-item-7",
      itemId: "item-7",
      quote: "carefully",
      contextBefore: "Read this ",
      contextAfter: ", then update the parser.",
    });

    transcript.remove();
    selection.removeAllRanges();
  });

  it("takes nearby context from the selected occurrence when text repeats", () => {
    const selection = selectText("same, then same.", 11, 15);
    const transcript = document.querySelector("main") as HTMLElement;

    expect(textSelectionToAnchor(selection, transcript)).toMatchObject({
      quote: "same",
      contextBefore: "same, then ",
      contextAfter: ".",
    });

    transcript.remove();
    selection.removeAllRanges();
  });

  it("rejects empty, whitespace-only, outside, and cross-response selections", () => {
    const selection = selectText("   ", 0, 3);
    const transcript = document.querySelector("main") as HTMLElement;
    expect(textSelectionToAnchor(selection, transcript)).toBeNull();

    const outside = document.createTextNode("outside response");
    document.body.append(outside);
    const outsideRange = document.createRange();
    outsideRange.selectNodeContents(outside);
    selection.removeAllRanges();
    selection.addRange(outsideRange);
    expect(textSelectionToAnchor(selection, transcript)).toBeNull();

    const firstText = transcript.querySelector("p")!.firstChild!;
    const secondResponse = document.createElement("div");
    secondResponse.dataset.localChatAssistantResponseId = "response-item-8";
    const secondText = document.createTextNode("another response");
    secondResponse.append(secondText);
    transcript.append(secondResponse);
    const crossResponse = document.createRange();
    crossResponse.setStart(firstText, 0);
    crossResponse.setEnd(secondText, secondText.textContent!.length);
    selection.removeAllRanges();
    selection.addRange(crossResponse);
    expect(textSelectionToAnchor(selection, transcript)).toBeNull();

    transcript.remove();
    outside.remove();
    selection.removeAllRanges();
  });

  it("formats multiple comments as quoted context with an optional follow-up", () => {
    const comments: PendingTextComment[] = [
      {
        kind: "text",
        id: "comment-1",
        responseId: "response-item-7",
        itemId: "item-7",
        quote: "carefully",
        contextBefore: "Read this ",
        contextAfter: ", then update the parser.",
        body: "Please explain this word.",
      },
      {
        kind: "text",
        id: "comment-2",
        responseId: "response-item-7",
        itemId: "item-7",
        quote: "update the parser",
        contextBefore: "Read this carefully, then ",
        contextAfter: ".",
        body: "Which parser?",
      },
    ];

    expect(formatTextCommentsForReply(comments, "")).toBe(
      "Comments on the previous response:\n\n" +
        "1. Selected text:\n> carefully\n" +
        "Nearby context: Read this ⟦selection⟧, then update the parser.\n" +
        "Comment: Please explain this word.\n\n" +
        "2. Selected text:\n> update the parser\n" +
        "Nearby context: Read this carefully, then ⟦selection⟧.\n" +
        "Comment: Which parser?"
    );
    expect(
      formatTextCommentsForReply(comments.slice(0, 1), "And check the tests.")
    ).toContain("Follow-up:\nAnd check the tests.");
  });

  describe("diff comments", () => {
    const worktreeComment: PendingDiffComment = {
      kind: "diff",
      id: "d1",
      body: "  Rename this.  ",
      home: { kind: "worktree", wholeBranch: false },
      path: "src/a.ts",
      side: "new",
      startLine: 12,
      endLine: 12,
      hunk: "@@ -10,3 +10,3 @@\n ctx\n-old\n+new",
      outdated: false,
    };
    const toolComment: PendingDiffComment = {
      kind: "diff",
      id: "d2",
      body: "Why removed?\nExplain.",
      home: { kind: "tool_call", toolUseId: "tool-1", toolName: "Edit" },
      path: "src/b.ts",
      side: "old",
      startLine: 4,
      endLine: 6,
      hunk: "@@ -3,4 +3,2 @@\n ctx\n-a\n-b\n-c",
      outdated: true,
    };
    const textComment: PendingTextComment = {
      kind: "text",
      id: "t1",
      responseId: "r",
      itemId: null,
      quote: "x",
      contextBefore: "",
      contextAfter: "",
      body: "What is x?",
    };

    it("formats a single-line All Changes comment", () => {
      expect(formatTextCommentsForReply([worktreeComment], "")).toBe(
        [
          "Review comments on the worktree changes:",
          "",
          "1. All Changes · src/a.ts:12 (new)",
          "   ```diff",
          "   @@ -10,3 +10,3 @@",
          "    ctx",
          "   -old",
          "   +new",
          "   ```",
          "   Comment: Rename this.",
        ].join("\n")
      );
    });

    it("formats a tool-call range on the old side with the outdated marker", () => {
      expect(formatTextCommentsForReply([toolComment], "")).toBe(
        [
          "Review comments on the worktree changes:",
          "",
          "1. Tool call Edit src/b.ts · src/b.ts:4-6 (old) [outdated]",
          "   ```diff",
          "   @@ -3,4 +3,2 @@",
          "    ctx",
          "   -a",
          "   -b",
          "   -c",
          "   ```",
          "   Comment: Why removed?",
          "   Explain.",
        ].join("\n")
      );
    });

    it("mixes text and diff comments in one numbered list with a follow-up", () => {
      const message = formatTextCommentsForReply(
        [textComment, worktreeComment],
        "Thanks."
      );
      expect(message).toBe(
        [
          "Comments on the previous response and on the worktree changes:",
          "",
          "1. Selected text:",
          "> x",
          "Comment: What is x?",
          "",
          "2. All Changes · src/a.ts:12 (new)",
          "   ```diff",
          "   @@ -10,3 +10,3 @@",
          "    ctx",
          "   -old",
          "   +new",
          "   ```",
          "   Comment: Rename this.",
          "",
          "Follow-up:",
          "Thanks.",
        ].join("\n")
      );
    });

    it("labels a tool call without a name by its path and widens the fence around backticks", () => {
      const message = formatTextCommentsForReply(
        [
          {
            ...toolComment,
            outdated: false,
            home: { kind: "tool_call", toolUseId: "tool-1" },
            hunk: "@@ -1 +1 @@\n-a\n+```ts",
          },
        ],
        ""
      );
      expect(message).toContain("1. Tool call src/b.ts · src/b.ts:4-6 (old)\n");
      expect(message).toContain(
        "   ````diff\n   @@ -1 +1 @@\n   -a\n   +```ts\n   ````\n"
      );
    });

    it("keeps text-only messages unchanged", () => {
      expect(formatTextCommentsForReply([textComment], "")).toBe(
        "Comments on the previous response:\n\n1. Selected text:\n> x\nComment: What is x?"
      );
    });
  });
});

import { describe, expect, it } from "vitest";
import {
  formatTextCommentsForReply,
  textSelectionToAnchor,
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
        id: "comment-1",
        responseId: "response-item-7",
        itemId: "item-7",
        quote: "carefully",
        contextBefore: "Read this ",
        contextAfter: ", then update the parser.",
        body: "Please explain this word.",
      },
      {
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
});

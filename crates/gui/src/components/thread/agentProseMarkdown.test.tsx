import { render, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import type { ChatMessage } from "../../stores/chatStore";
import type { LiveChatMessage } from "../../stores/liveChatStore";
import { chatMessagesToThread } from "../ChatWindow/chatMessagesToThread";
import { liveChatToThread } from "../LiveChatWindow/liveChatToThread";
import { Thread, type ThreadModel } from ".";

const TS = "2026-06-22T12:00:00Z";

function renderAsChatThread(thread: ThreadModel): HTMLElement {
  const { container } = render(
    <Thread
      thread={thread}
      mode="bare"
      reveal="shallow"
      showHead={false}
      interactive
    />
  );
  const prose = container.querySelector(".evprose");
  expect(prose).toBeInTheDocument();
  return prose as HTMLElement;
}

function expectBlockMarkdown(
  prose: HTMLElement,
  items: string[],
  language: string,
  codeFragment: string
) {
  expect(prose.querySelector(".markdown-content")).toBeInTheDocument();

  const list = within(prose).getByRole("list");
  const renderedItems = within(list)
    .getAllByRole("listitem")
    .map((item) => item.textContent);
  expect(renderedItems).toEqual(items);

  expect(within(prose).getByText(language)).toBeInTheDocument();
  const codeEl = prose.querySelector(".markdown-content code");
  expect(codeEl).toBeInTheDocument();
  expect(codeEl).toHaveTextContent(codeFragment);
  expect(prose).not.toHaveTextContent("```");
}

describe("chat agent prose markdown rendering", () => {
  it("renders local scoped chat assistant prose as block markdown", () => {
    const markdown = [
      "Plan:",
      "",
      "- First local item",
      "- Second local item",
      "",
      "```ts",
      "const local = true;",
      "```",
    ].join("\n");
    const messages: ChatMessage[] = [
      { kind: "user", text: "show me a plan", timestamp: TS },
      {
        kind: "assistant",
        text: markdown,
        timestamp: TS,
        isPartial: true,
      },
    ];

    const prose = renderAsChatThread(
      chatMessagesToThread(messages, { collapsed: new Set<string>() })
    );

    expectBlockMarkdown(
      prose,
      ["First local item", "Second local item"],
      "ts",
      "const local = true;"
    );
    expect(prose.querySelector(".ev-cursor")).toBeInTheDocument();
  });

  it("renders live chat assistant prose as block markdown", () => {
    const markdown = [
      "Steps:",
      "",
      "- First live item",
      "- Second live item",
      "",
      "```bash",
      "vtb ready",
      "```",
    ].join("\n");
    const messages: LiveChatMessage[] = [
      {
        id: "u1",
        role: "user",
        content: "what is ready?",
        content_format: "plain",
        createdAt: TS,
        pending: false,
        error: null,
      },
      {
        id: "a1",
        role: "assistant",
        content: markdown,
        content_format: "markdown",
        createdAt: TS,
        pending: true,
        error: null,
      },
    ];

    const prose = renderAsChatThread(liveChatToThread(messages));

    expectBlockMarkdown(
      prose,
      ["First live item", "Second live item"],
      "bash",
      "vtb ready"
    );
    expect(prose.querySelector(".ev-cursor")).toBeInTheDocument();
  });

  it("renders explicit plain live chat assistant prose without markdown parsing", () => {
    const plainText = [
      "Literal syntax:",
      "",
      "- not a list item",
      "*not emphasis*",
      "",
      "```ts",
      "const plain = true;",
      "```",
    ].join("\n");
    const messages: LiveChatMessage[] = [
      {
        id: "a-plain",
        role: "assistant",
        content: plainText,
        content_format: "plain",
        createdAt: TS,
        pending: false,
        error: null,
      },
    ];

    const prose = renderAsChatThread(liveChatToThread(messages));

    expect(prose.querySelector(".markdown-content")).not.toBeInTheDocument();
    expect(prose.querySelector("ul")).not.toBeInTheDocument();
    expect(prose.querySelector("em")).not.toBeInTheDocument();
    expect(prose).toHaveTextContent("- not a list item");
    expect(prose).toHaveTextContent("*not emphasis*");
    expect(prose).toHaveTextContent("```ts");
  });
});

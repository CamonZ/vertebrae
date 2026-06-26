import { render, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import type { ChatMessage } from "../../stores/chatStore";
import { chatMessagesToThread } from "../ChatWindow/chatMessagesToThread";
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
  it("renders local chat assistant prose as block markdown", () => {
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

  it("renders completed local chat assistant prose as block markdown", () => {
    const markdown = [
      "Steps:",
      "",
      "- First completed item",
      "- Second completed item",
      "",
      "```bash",
      "vtb ready",
      "```",
    ].join("\n");
    const messages: ChatMessage[] = [
      { kind: "user", text: "what is ready?", timestamp: TS },
      {
        kind: "assistant",
        text: markdown,
        timestamp: TS,
        isPartial: false,
      },
    ];

    const prose = renderAsChatThread(
      chatMessagesToThread(messages, { collapsed: new Set<string>() })
    );

    expectBlockMarkdown(
      prose,
      ["First completed item", "Second completed item"],
      "bash",
      "vtb ready"
    );
    expect(prose.querySelector(".ev-cursor")).not.toBeInTheDocument();
  });

});

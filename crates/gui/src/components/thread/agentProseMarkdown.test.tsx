import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { ChatMessage } from "../../stores/chatStore";
import { chatMessagesToThread } from "../ChatWindow/chatMessagesToThread";
import { Thread, type ThreadModel } from ".";

afterEach(() => vi.unstubAllGlobals());

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
  it("preserves local partial prose as literal text", () => {
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

    expect(prose.querySelector(".markdown-content")).not.toBeInTheDocument();
    expect(prose.textContent).toBe(markdown);
    expect(prose.querySelector(".ev-cursor")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Copy raw Markdown" })).toBeNull();
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

  it("copies each completed block from its original markdown source", async () => {
    const first = [
      "",
      "| Name | Value |",
      "| --- | --- |",
      "| State | Ready |",
      "",
      "```ts",
      "const ready = true;",
      "```",
      "",
      'Payload {"nested": {"value": 1}}',
      "",
    ].join("\n");
    const second = "**A separate reply block**  \n";
    const writeText = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal("navigator", { ...navigator, clipboard: { writeText } });

    renderAsChatThread(
      chatMessagesToThread(
        [
          { kind: "user", text: "Show a report", timestamp: TS },
          { kind: "assistant", text: first, timestamp: TS, itemId: "first" },
          { kind: "assistant", text: second, timestamp: TS, itemId: "second" },
        ],
        { collapsed: new Set<string>() }
      )
    );

    expect(screen.getByRole("table")).toBeInTheDocument();
    const [firstCopy, secondCopy] = screen.getAllByRole("button", {
      name: "Copy raw Markdown",
    });
    expect(firstCopy).toHaveAttribute("data-focus-halo");
    act(() => firstCopy.focus());
    fireEvent.click(firstCopy);
    expect(await screen.findByText("Copied")).toBeInTheDocument();
    expect(firstCopy).toHaveFocus();
    expect(firstCopy).toHaveAttribute("data-copy-status", "copied");
    expect(writeText).toHaveBeenNthCalledWith(1, first);
    fireEvent.click(secondCopy);
    await waitFor(() => expect(screen.getAllByText("Copied")).toHaveLength(2));
    expect(writeText.mock.calls).toEqual([[first], [second]]);
  });

  it("reports a clipboard failure in the reply action", async () => {
    const writeText = vi.fn().mockRejectedValue(new Error("Clipboard denied"));
    vi.stubGlobal("navigator", { ...navigator, clipboard: { writeText } });

    renderAsChatThread(
      chatMessagesToThread(
        [{ kind: "assistant", text: "Reply", timestamp: TS }],
        { collapsed: new Set<string>() }
      )
    );

    const button = screen.getByRole("button", { name: "Copy raw Markdown" });
    fireEvent.click(button);
    expect(await screen.findByText("Could not copy")).toHaveRole("status");
    expect(screen.queryByText("Copied")).toBeNull();
    expect(button).toHaveAttribute("data-copy-status", "failed");

    writeText.mockResolvedValue(undefined);
    fireEvent.click(button);
    expect(await screen.findByText("Copied")).toHaveRole("status");
    expect(button).toHaveAttribute("data-copy-status", "copied");
  });
});

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { EventRow } from "../thread/EventRow";
import { FileReferenceNavigationContext } from "../shared/FileReferenceNavigationContext";
import {
  formatTextCommentsForReply,
  type PendingDiffComment,
  type PendingGithubThreadComment,
  type PendingTextComment,
} from "./assistantTextComments";

const reveal = vi.hoisted(() => vi.fn());
vi.mock("./commentHighlight", async (importActual) => ({
  ...(await importActual<typeof import("./commentHighlight")>()),
  revealCommentAnchor: reveal,
}));

const text: PendingTextComment = {
  kind: "text",
  id: "t1",
  responseId: "r1",
  itemId: null,
  quote: "pushes downward",
  contextBefore: "the arch ",
  contextAfter: " on the abutment.",
  body: "Does it grow with span?",
};
const diff: PendingDiffComment = {
  kind: "diff",
  id: "d1",
  body: "Why clamp here?",
  home: { kind: "worktree", wholeBranch: false },
  path: "src/load.ts",
  side: "new",
  startLine: 42,
  endLine: 43,
  hunk: "@@ -42,2 +42,2 @@\n const a = 1;\n+const b = 2;",
  outdated: true,
};
const payload = formatTextCommentsForReply([text, diff], "Answer both.");

function Transcript({ response }: { response: string }) {
  return (
    <div data-transcript-viewport="">
      <div data-local-chat-assistant-response-id="r1">
        <p>{response}</p>
      </div>
      <EventRow
        evt="u1"
        type="user"
        label="You"
        text={payload}
        textFormat="comments"
      />
    </div>
  );
}

afterEach(() => {
  cleanup();
  reveal.mockReset();
});

describe("sent comments in the user turn", () => {
  it("renders one quote card per comment, then the follow-up", () => {
    render(<Transcript response="the arch pushes downward on the abutment." />);
    const list = screen.getByRole("list", {
      name: "Comments on the previous response and on the worktree changes",
    });
    const cards = list.querySelectorAll(":scope > li.vtb-comment-card");
    expect([...cards].map((card) => card.getAttribute("data-kind"))).toEqual([
      "text",
      "diff",
    ]);
    expect(cards[0].querySelector("mark")?.textContent).toBe("pushes downward");
    expect(cards[0].textContent).toContain("Does it grow with span?");
    expect(cards[1].querySelector("pre")?.textContent).toContain(
      "+const b = 2;"
    );
    expect(cards[1].textContent).toContain("outdated");
    expect(screen.getByText("Answer both.")).toBeTruthy();
    // Markdown syntax of the payload never shows.
    expect(list.textContent).not.toContain("**");
    expect(list.textContent).not.toContain("```");
  });

  it("jumps a text card back to its quote in an earlier response", () => {
    render(<Transcript response="the arch pushes downward on the abutment." />);
    const anchor = screen.getByRole("button", {
      name: "Comment 1: Show the quoted text in the transcript",
    });
    fireEvent.click(anchor);
    expect(reveal).toHaveBeenCalledTimes(1);
    expect(reveal.mock.calls[0][0].toString()).toBe("pushes downward");
    expect(anchor.hasAttribute("data-missing")).toBe(false);
  });

  it("marks a text card whose quote is gone", () => {
    render(<Transcript response="An unrelated answer." />);
    const anchor = screen.getByRole("button", { name: /^Comment 1:/ });
    fireEvent.click(anchor);
    expect(reveal).not.toHaveBeenCalled();
    expect(anchor.hasAttribute("data-missing")).toBe(true);
    expect(anchor.getAttribute("aria-label")).toBe(
      "Comment 1: The quoted text is no longer in the transcript"
    );
  });

  it("opens a diff card's file, and is inert without navigation", () => {
    const navigate = vi.fn();
    const { unmount } = render(
      <FileReferenceNavigationContext.Provider value={navigate}>
        <Transcript response="x" />
      </FileReferenceNavigationContext.Provider>
    );
    fireEvent.click(
      screen.getByRole("button", {
        name: "Comment 2: open src/load.ts:42-43 (new)",
      })
    );
    expect(navigate).toHaveBeenCalledWith({
      root: null,
      path: "src/load.ts",
      line: 42,
      column: null,
    });
    unmount();

    render(<Transcript response="x" />);
    expect(
      (screen.getByRole("button", { name: /^Comment 2:/ }) as HTMLButtonElement)
        .disabled
    ).toBe(true);
  });

  it("names a GitHub thread's card and renders its thread as markdown", () => {
    const github: PendingGithubThreadComment = {
      kind: "github_thread",
      id: "g1",
      body: "Worth a test?",
      githubThreadId: "PRRT_1",
      discussionId: "d1",
      path: "src/lib.rs",
      side: "new",
      startLine: 13,
      endLine: 13,
      code: "let total = 2;",
      author: "alice",
      comments: [{ author: "alice", body: "Why **2**?" }],
      turns: [
        { role: "user", text: "Is it idempotent?" },
        { role: "assistant", text: "Yes." },
      ],
    };
    render(
      <EventRow
        evt="u3"
        type="user"
        label="You"
        text={formatTextCommentsForReply([github], "")}
        textFormat="comments"
      />
    );
    const card = screen
      .getByRole("button", {
        name: "Comment 1: GitHub thread from alice, open src/lib.rs:13 (new)",
      })
      .closest("li")!;
    expect(card).toHaveAttribute("data-kind", "github_thread");
    // The thread's comment is quoted and its author bold, not raw Markdown.
    const quote = card.querySelector("blockquote")!;
    expect(quote).toHaveTextContent("alice: Why 2?");
    expect(quote.querySelector("strong")).toHaveTextContent("alice:");
    expect(card).toHaveTextContent("You: Is it idempotent?");
    expect(card).toHaveTextContent("Worth a test?");
    expect(card.textContent).not.toContain("**");
  });

  it("renders text that is not a comment set as ordinary markdown", () => {
    render(
      <EventRow
        evt="u2"
        type="user"
        label="You"
        text="Comments on the previous response:\n\nnot numbered"
        textFormat="comments"
      />
    );
    expect(screen.queryByRole("list")).toBeNull();
    expect(screen.getByText(/not numbered/)).toBeTruthy();
  });
});

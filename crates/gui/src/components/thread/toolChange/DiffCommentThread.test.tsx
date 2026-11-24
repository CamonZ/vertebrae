import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PendingDiffComment } from "../../ChatWindow/assistantTextComments";
import { DiffCommentThread } from "./DiffCommentThread";
import { DiffReviewContext, type DiffReviewValue } from "./DiffReviewContext";

const comment = (body: string): PendingDiffComment => ({
  kind: "diff",
  id: "c1",
  body,
  home: { kind: "worktree", wholeBranch: false },
  path: "app.py",
  side: "new",
  startLine: 3,
  endLine: 3,
  hunk: "@@ -1 +1 @@\n+x",
  outdated: false,
});

function review(comments: PendingDiffComment[], removeComment = vi.fn()) {
  return {
    comments,
    placements: [],
    chain: [],
    worktree: null,
    focus: null,
    addComment: vi.fn(),
    updateComment: vi.fn(),
    removeComment,
  } satisfies DiffReviewValue;
}

beforeEach(() => {
  vi.useFakeTimers({
    toFake: ["requestAnimationFrame", "cancelAnimationFrame"],
  });
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("DiffCommentThread bubble", () => {
  it("leads with the comment text and keeps location as a caption", () => {
    const remove = vi.fn();
    render(
      <DiffReviewContext.Provider value={review([comment("Why X?")], remove)}>
        <DiffCommentThread
          annotation={{ commentIds: ["c1"], draft: false }}
          onCancelDraft={vi.fn()}
        />
      </DiffReviewContext.Provider>
    );
    expect(screen.getByText("Why X?")).toHaveClass("diff-comment-body");
    expect(screen.getByText(/All Changes · app\.py:3 \(new\)/)).toHaveClass(
      "diff-comment-where"
    );
    const edit = screen.getByRole("button", { name: "Edit diff comment" });
    expect(edit).toHaveClass("chat-comment-icon-button");
    expect(edit).not.toHaveTextContent(/\w/);
    fireEvent.click(
      screen.getByRole("button", { name: "Remove diff comment" })
    );
    expect(remove).toHaveBeenCalledWith("c1");
  });

  it("says so when an attachment has no comment text", () => {
    render(
      <DiffReviewContext.Provider value={review([comment("")])}>
        <DiffCommentThread
          annotation={{ commentIds: ["c1"], draft: false }}
          onCancelDraft={vi.fn()}
        />
      </DiffReviewContext.Provider>
    );
    expect(
      screen.getByText("No comment — attached as context")
    ).toHaveAttribute("data-empty");
  });
});

describe("DiffCommentThread composer focus", () => {
  it("takes focus even when the first attempts fail to land", () => {
    // Pierre can slot the annotation a frame after React mounts it, so an
    // early focus() does nothing.
    let attempts = 0;
    const focus = HTMLElement.prototype.focus;
    vi.spyOn(HTMLElement.prototype, "focus").mockImplementation(function (
      this: HTMLElement,
      options?: FocusOptions
    ) {
      if (this instanceof HTMLTextAreaElement && ++attempts <= 3) return;
      focus.call(this, options);
    });
    render(
      <DiffCommentThread
        annotation={{ commentIds: [], draft: true }}
        onDiscussDraft={vi.fn()}
        onCancelDraft={vi.fn()}
      />
    );
    const input = screen.getByRole("textbox", { name: /New selection/ });
    for (let i = 0; i < 6; i++) act(() => vi.advanceTimersToNextFrame());
    expect(document.activeElement).toBe(input);
  });

  it("starts at two rows without a manual resize grip", () => {
    render(
      <DiffCommentThread
        annotation={{ commentIds: [], draft: true }}
        onDiscussDraft={vi.fn()}
        onCancelDraft={vi.fn()}
      />
    );
    expect(screen.getByRole("textbox")).toHaveAttribute("rows", "2");
  });
});

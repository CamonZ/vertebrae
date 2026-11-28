import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { FileProps } from "@pierre/diffs/react";
import { useEffect, useState } from "react";
import { expect, it, vi } from "vitest";
import { commands, type ReviewThread } from "../../../bindings";
import {
  placeWorktreeDiscussions,
  readSavedDiscussion,
} from "../restoreSelectionDiscussions";
import { SelectionDiscussionContext } from "../selectionDiscussionState";
import {
  discussionFirstTurn,
  type SelectionThread,
} from "../selectionDiscussions";
import type { ReviewAnnotation } from "../../thread/toolChange/DiffCommentThread";
import DocumentEditor from "./DocumentEditor";

vi.mock("@pierre/diffs/react", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@pierre/diffs/react")>()),
  File: ({
    file,
    options,
    lineAnnotations,
    renderAnnotation,
  }: FileProps<ReviewAnnotation, undefined>) => (
    <>
      <button
        type="button"
        onClick={() => options?.onGutterUtilityClick?.({ start: 2, end: 1 })}
      >
        Discuss lines 1–2
      </button>
      {lineAnnotations?.map((annotation) => (
        <div
          key={annotation.lineNumber}
          aria-label={`Line ${annotation.lineNumber}`}
        >
          {renderAnnotation?.(annotation, file)}
        </div>
      ))}
    </>
  ),
}));

const checkout = "/fixture";
const oldTurn = { sessionId: "chat", turnId: "old" };
const newTurn = { sessionId: "chat", turnId: "new" };

function FileFixture({
  turn,
  dirty = false,
  row,
  discuss = vi.fn(),
}: {
  turn: typeof oldTurn | null;
  dirty?: boolean;
  row?: ReviewThread;
  discuss?: NonNullable<
    React.ContextType<typeof SelectionDiscussionContext>
  >["discuss"];
}) {
  const [threads, setThreads] = useState<SelectionThread[]>([]);
  useEffect(() => {
    if (row)
      void readSavedDiscussion(
        row,
        { worktreePath: checkout, parentChatId: "chat" },
        [],
        new Map()
      ).then((record) => {
        if (record) setThreads(placeWorktreeDiscussions([record], null));
      });
  }, [row]);
  return (
    <SelectionDiscussionContext.Provider
      value={{
        canAsk: true,
        canAskFullFile: true,
        threads,
        activeId: null,
        selection: null,
        select: vi.fn(),
        discuss,
        reopen: vi.fn(),
        send: vi.fn(),
        attach: vi.fn(),
        cancel: vi.fn(),
        reconcile: vi.fn(),
        toggleCollapsed: vi.fn(),
        focusTaken: vi.fn(),
        discussGithub: vi.fn(() => Promise.resolve({ opened: true as const })),
        attachThread: vi.fn(),
        canAttachGithub: false,
        attachGithub: vi.fn(),
        revealed: vi.fn(),
        draft: vi.fn(() => ""),
        setDraft: vi.fn(),
        moveUnderGithub: vi.fn(async () => {}),
        reveal: null,
        focusRequest: null,
        collapsed: new Set(),
        anchorError: null,
      }}
    >
      <DocumentEditor
        key={turn?.turnId ?? "latest"}
        path="a.txt"
        view="file"
        contents={"saved first\nsaved second\nthird"}
        baseline={null}
        onChange={() => {}}
        readOnly={turn !== null}
        dirty={dirty}
        discussionSource={{ checkout, turn }}
      />
    </SelectionDiscussionContext.Provider>
  );
}

it("discusses a full-file range in file coordinates and blocks unsaved text", async () => {
  const user = userEvent.setup();
  const discuss = vi.fn().mockResolvedValue(true);
  const { rerender } = render(
    <FileFixture turn={null} dirty discuss={discuss} />
  );
  await user.click(screen.getByRole("button", { name: "Discuss lines 1–2" }));
  expect(screen.getByRole("alert")).toHaveTextContent("Save your edits");
  expect(screen.queryByRole("textbox")).toBeNull();
  expect(discuss).not.toHaveBeenCalled();

  rerender(<FileFixture turn={null} discuss={discuss} />);
  const input = screen.getByRole("textbox", {
    name: "New selection discussion",
  });
  await user.type(input, "why?");
  await user.click(screen.getByRole("button", { name: "Discuss inline" }));
  expect(discuss).toHaveBeenCalledExactlyOnceWith(
    expect.objectContaining({
      startLine: 1,
      endLine: 2,
      code: "saved first\nsaved second",
      fullFile: { checkout, turn: null },
    }),
    "why?"
  );
});

it("keeps a late restore on its recorded turn even when other views show identical text", async () => {
  const row: ReviewThread = {
    threadId: "old-thread",
    revision: 1,
    checkoutPath: checkout,
    payload: {
      parentChatId: "chat",
      path: "a.txt",
      side: "RIGHT",
      homeKind: "worktree",
      toolUseId: null,
      originalCommitId: "commit",
      originalBlobId: "blob",
      originalStartLine: 1,
      originalLine: 1,
      startLine: 1,
      line: 1,
      status: "open",
      outdatedNoted: false,
      originKind: "local",
      originRef: 'full-file:["chat","old"]',
    },
  };
  let resolve!: (
    result: Awaited<ReturnType<typeof commands.readReviewAnchor>>
  ) => void;
  const read = vi.spyOn(commands, "readReviewAnchor").mockReturnValueOnce(
    new Promise((done) => {
      resolve = done;
    })
  );
  const { rerender } = render(<FileFixture turn={oldTurn} row={row} />);
  await waitFor(() =>
    expect(read).toHaveBeenCalledExactlyOnceWith(checkout, row.threadId, {
      startLine: 1,
      line: 1,
    })
  );
  rerender(<FileFixture turn={newTurn} row={row} />);
  await act(async () => resolve({ status: "ok", data: "saved first\n" }));
  expect(
    screen.queryByRole("button", { name: "Reopen selection discussion" })
  ).toBeNull();
  rerender(<FileFixture turn={null} row={row} />);
  expect(
    screen.queryByRole("button", { name: "Reopen selection discussion" })
  ).toBeNull();
  rerender(<FileFixture turn={oldTurn} row={row} />);
  expect(screen.getByLabelText("Line 1")).toContainElement(
    screen.getByRole("button", { name: "Reopen selection discussion" })
  );
  read.mockRestore();
});

it("sends the recorded selection in the discussion's first turn", async () => {
  const modelRequest = vi.fn();
  const discuss = vi.fn().mockImplementation(async (anchor, question) => {
    const context = discussionFirstTurn(anchor, false, question);
    modelRequest(context);
    return true;
  });
  const user = userEvent.setup();
  render(<FileFixture turn={oldTurn} discuss={discuss} />);
  const file = screen.getByLabelText(/File lines/);
  act(() => file.focus());
  await user.keyboard("{ArrowDown}{Shift>}{ArrowDown}{/Shift}c");
  await user.type(
    screen.getByRole("textbox", { name: "New selection discussion" }),
    "why?"
  );
  await user.click(screen.getByRole("button", { name: "Discuss inline" }));
  expect(discuss).toHaveBeenCalledExactlyOnceWith(
    expect.objectContaining({
      fullFile: { checkout, turn: oldTurn },
      code: "saved first\nsaved second",
    }),
    "why?"
  );
  expect(modelRequest).toHaveBeenCalledWith(
    expect.stringContaining('"code":"saved first\\nsaved second"')
  );
});

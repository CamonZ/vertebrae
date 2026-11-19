import { act, fireEvent, render, screen } from "@testing-library/react";
import {
  forwardRef,
  useImperativeHandle,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { WorktreeChange } from "../../../bindings";
import PatchFiles from "../../thread/toolChange/PatchFiles";
import AllChangesRenderer, { type AllChangesViewProps } from "./AllChangesView";
import { preparePatches } from "../../thread/toolChange/preparePatches";
import {
  DiffReviewContext,
  type DiffReviewValue,
} from "../../thread/toolChange/DiffReviewContext";
import {
  computePlacements,
  createDiffComment,
  parseWorktreeSnapshot,
} from "../../thread/toolChange/diffComments";
import {
  parsePatch,
  type ToolPatch,
} from "../../thread/toolChange/diffLineMapper";
import {
  filePatch,
  numbered,
} from "../../thread/toolChange/diffPatchBuilder.test.helpers";
import type { PendingComment } from "../assistantTextComments";
import {
  SelectionDiscussionActionsContext,
  type DiscussionActions,
} from "../selectionDiscussionState";

interface Props {
  fileDiff: { name: string };
  options?: {
    enableGutterUtility?: boolean;
    enableLineSelection?: boolean;
    onGutterUtilityClick?: (range: unknown, context?: unknown) => void;
  };
  items?: Array<{
    id: string;
    fileDiff: { name: string };
    annotations?: Array<{
      side: string;
      lineNumber: number;
      metadata: unknown;
    }>;
    version?: number;
    collapsed?: boolean;
  }>;
  lineAnnotations?: Array<{
    side: string;
    lineNumber: number;
    metadata: unknown;
  }>;
  renderAnnotation?: (...args: unknown[]) => ReactNode;
}

const seen = vi.hoisted(() => ({
  scrollTo: vi.fn(),
  fileDiffs: [] as Array<Record<string, unknown>>,
  codeView: null as Record<string, unknown> | null,
  range: { start: 6, end: 6, side: "additions" } as Record<string, unknown>,
}));

// Pierre needs real layout; these stand-ins record props and draw annotations.
vi.mock("@pierre/diffs/react", async (importOriginal) => {
  const original = await importOriginal<typeof import("@pierre/diffs/react")>();
  return {
    ...original,
    FileDiff: (props: Props) => {
      seen.fileDiffs.push(props as unknown as Record<string, unknown>);
      return (
        <div data-testid="file-diff">
          <button
            type="button"
            onClick={() => props.options?.onGutterUtilityClick?.(seen.range)}
          >
            gutter file diff
          </button>
          {props.lineAnnotations?.map((annotation) => (
            <div key={`${annotation.side}${annotation.lineNumber}`}>
              {props.renderAnnotation?.(annotation, props.fileDiff)}
            </div>
          ))}
        </div>
      );
    },
    CodeView: forwardRef(function CodeView(
      props: {
        items: NonNullable<Props["items"]>;
        options: Props["options"];
        renderCustomHeader(item: unknown): ReactNode;
        renderAnnotation?: (...args: unknown[]) => ReactNode;
      },
      ref
    ) {
      useImperativeHandle(ref, () => ({ scrollTo: seen.scrollTo }));
      seen.codeView = props as unknown as Record<string, unknown>;
      return (
        <div data-testid="code-view">
          {props.items.map((item) => (
            <div key={item.id}>
              {props.renderCustomHeader(item)}
              {!item.collapsed && (
                <>
                  <button
                    type="button"
                    onClick={() =>
                      props.options?.onGutterUtilityClick?.(seen.range, {
                        item,
                      })
                    }
                  >
                    gutter code view
                  </button>
                  {item.annotations?.map((annotation) => (
                    <div key={`${annotation.side}${annotation.lineNumber}`}>
                      {props.renderAnnotation?.(
                        annotation,
                        item.fileDiff,
                        item
                      )}
                    </div>
                  ))}
                </>
              )}
            </div>
          ))}
        </div>
      );
    }),
  };
});

const BASE = numbered("l", 20);
const WITH_X = [...BASE.slice(0, 5), "X", ...BASE.slice(5)];
const WITHOUT_L12 = WITH_X.filter((line) => line !== "l12");
const TOOL_1 = filePatch({ path: "f.ts", before: BASE, after: WITH_X });
const TOOL_2 = filePatch({ path: "f.ts", before: WITH_X, after: WITHOUT_L12 });
const ALL = filePatch({ path: "f.ts", before: BASE, after: WITHOUT_L12 });

const worktreeFiles: WorktreeChange[] = [
  {
    path: "f.ts",
    old_path: null,
    status: "modified",
    marker: null,
    totals: { additions: 1, deletions: 1, binary_files: 0 },
    patch: ALL,
  },
];

let nextId = 0;
function Harness({
  children,
  initial = [],
  focus = null,
}: {
  children: ReactNode;
  initial?: PendingComment[];
  focus?: DiffReviewValue["focus"];
}) {
  const [comments, setComments] = useState<PendingComment[]>(initial);
  const chain = useMemo<ToolPatch[]>(
    () => [
      { id: "tool-1", files: parsePatch(TOOL_1) },
      { id: "tool-2", files: parsePatch(TOOL_2) },
    ],
    []
  );
  const worktree = useMemo(() => parseWorktreeSnapshot(false, [ALL]), []);
  const value = useMemo<DiffReviewValue>(() => {
    const diffComments = comments.filter((comment) => comment.kind === "diff");
    return {
      comments: diffComments,
      placements: computePlacements(comments, chain, worktree),
      chain,
      worktree,
      focus,
      addComment: (input) => {
        const comment = createDiffComment({ ...input, id: `c${nextId++}` });
        if (comment) setComments((current) => [...current, comment]);
      },
      updateComment: (id, body) =>
        setComments((current) =>
          current.map((c) => (c.id === id ? { ...c, body } : c))
        ),
      removeComment: (id) =>
        setComments((current) => current.filter((c) => c.id !== id)),
    };
  }, [comments, chain, worktree, focus]);
  return (
    <DiffReviewContext.Provider value={value}>
      {children}
    </DiffReviewContext.Provider>
  );
}

function lastFileDiff() {
  return seen.fileDiffs[seen.fileDiffs.length - 1] as unknown as Props;
}
function codeViewItem() {
  return (seen.codeView as unknown as { items: NonNullable<Props["items"]> })
    .items[0];
}

function addComment(button: string, body: string) {
  fireEvent.click(screen.getByRole("button", { name: button }));
  fireEvent.change(screen.getByRole("textbox", { name: "New diff comment" }), {
    target: { value: body },
  });
  fireEvent.click(screen.getByRole("button", { name: "Add comment" }));
}

describe("diff review across PatchFiles and AllChangesView", () => {
  beforeEach(() => {
    seen.scrollTo.mockReset();
    seen.fileDiffs.length = 0;
    seen.codeView = null;
    seen.range = { start: 6, end: 6, side: "additions" };
    nextId = 0;
  });

  function renderBoth() {
    return render(
      <Harness>
        <PatchFiles
          patch={TOOL_1}
          review={{ toolUseId: "tool-1", toolName: "Edit" }}
        />
        <AllChangesView
          files={worktreeFiles}
          jumpTarget={null}
          onOpen={vi.fn()}
        />
      </Harness>
    );
  }

  it("enables the gutter only where review is available", () => {
    renderBoth();
    expect(lastFileDiff().options?.enableGutterUtility).toBe(true);
    expect(
      (seen.codeView as unknown as Props).options?.enableGutterUtility
    ).toBe(true);
    seen.fileDiffs.length = 0;
    render(<PatchFiles patch={TOOL_1} />);
    expect(lastFileDiff().options?.enableGutterUtility).toBeUndefined();
    expect(lastFileDiff().lineAnnotations).toBeUndefined();
  });

  it("shows a comment written on a tool call in All Changes at the same line", () => {
    renderBoth();
    addComment("gutter file diff", "Why X?");
    // X is line 6 of tool-1 and line 6 of the working tree.
    expect(lastFileDiff().lineAnnotations).toEqual([
      {
        side: "additions",
        lineNumber: 6,
        metadata: { commentIds: ["c0"], draft: false },
      },
    ]);
    expect(codeViewItem().annotations).toEqual([
      {
        side: "additions",
        lineNumber: 6,
        metadata: { commentIds: ["c0"], draft: false },
      },
    ]);
    // The item is republished so CodeView picks the annotation up.
    expect(codeViewItem().version).toBeGreaterThan(0);
    expect(screen.getAllByTestId("diff-comment")).toHaveLength(2);
    expect(screen.getAllByText("Why X?")).toHaveLength(2);
  });

  it("shows a comment written in All Changes on the call that produced the line", () => {
    renderBoth();
    addComment("gutter code view", "Rename X");
    expect(codeViewItem().annotations).toEqual([
      expect.objectContaining({ side: "additions", lineNumber: 6 }),
    ]);
    expect(lastFileDiff().lineAnnotations).toEqual([
      expect.objectContaining({ side: "additions", lineNumber: 6 }),
    ]);
  });

  it("puts a removed line's comment on the old side of the removing call", () => {
    seen.range = { start: 12, end: 12, side: "deletions" };
    render(
      <Harness>
        <PatchFiles patch={TOOL_2} review={{ toolUseId: "tool-2" }} />
        <AllChangesView
          files={worktreeFiles}
          jumpTarget={null}
          onOpen={vi.fn()}
        />
      </Harness>
    );
    // l12 is line 13 in tool-2 (after X) and line 12 at the baseline.
    seen.range = { start: 13, end: 13, side: "deletions" };
    addComment("gutter file diff", "Why remove l12?");
    expect(codeViewItem().annotations).toEqual([
      expect.objectContaining({ side: "deletions", lineNumber: 12 }),
    ]);
  });

  it("removes a comment from both diffs", () => {
    renderBoth();
    addComment("gutter file diff", "Why X?");
    fireEvent.click(
      screen.getAllByRole("button", { name: "Remove diff comment" })[0]
    );
    expect(lastFileDiff().lineAnnotations).toEqual([]);
    expect(codeViewItem().annotations).toEqual([]);
  });

  it("edits a comment from its card", () => {
    renderBoth();
    addComment("gutter file diff", "Why X?");
    fireEvent.click(
      screen.getAllByRole("button", { name: "Edit diff comment" })[0]
    );
    fireEvent.change(screen.getByRole("textbox", { name: "Edit comment" }), {
      target: { value: "Explain X" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(screen.getAllByText("Explain X")).toHaveLength(2);
  });

  it("ignores a gutter click outside the patch and can cancel the composer", () => {
    renderBoth();
    seen.range = { start: 1, end: 1, side: "additions" };
    fireEvent.click(screen.getByRole("button", { name: "gutter file diff" }));
    expect(screen.queryByRole("textbox")).toBeNull();
    seen.range = { start: 6, end: 6, side: "additions" };
    fireEvent.click(screen.getByRole("button", { name: "gutter file diff" }));
    expect(lastFileDiff().lineAnnotations).toEqual([
      expect.objectContaining({
        metadata: { commentIds: [], draft: true },
      }),
    ]);
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(lastFileDiff().lineAnnotations).toEqual([]);
  });

  it("preserves pending comments through folding and expands an explicit comment focus", () => {
    const view = render(
      <Harness>
        <AllChangesView
          files={worktreeFiles}
          jumpTarget={null}
          onOpen={vi.fn()}
        />
      </Harness>
    );
    addComment("gutter code view", "Keep this pending comment");
    const toggle = screen.getByRole("button", { name: "Toggle diff for f.ts" });
    fireEvent.click(toggle);
    expect(screen.queryByText("Keep this pending comment")).toBeNull();
    expect(codeViewItem().annotations).toHaveLength(1);
    seen.scrollTo.mockImplementation(() =>
      expect(codeViewItem().collapsed).toBe(false)
    );
    view.rerender(
      <Harness focus={{ commentId: "c0", nonce: 1 }}>
        <AllChangesView
          files={worktreeFiles}
          jumpTarget={null}
          onOpen={vi.fn()}
        />
      </Harness>
    );
    expect(screen.getByText("Keep this pending comment")).toBeVisible();
    expect(toggle).toHaveAttribute("aria-expanded", "true");
    expect(seen.scrollTo).toHaveBeenCalledWith({
      type: "line",
      id: "f.ts",
      lineNumber: 6,
      side: "additions",
      align: "center",
    });
  });

  it("keeps a file folded when a new annotation arrives from another surface", () => {
    renderBoth();
    fireEvent.click(
      screen.getByRole("button", { name: "Toggle diff for f.ts" })
    );
    const version = codeViewItem().version!;
    addComment("gutter file diff", "Arrived during folding");
    expect(codeViewItem().collapsed).toBe(true);
    expect(codeViewItem().version).toBeGreaterThan(version);
    expect(codeViewItem().annotations).toHaveLength(1);
    expect(screen.getAllByText("Arrived during folding")).toHaveLength(1);
    fireEvent.click(
      screen.getByRole("button", { name: "Toggle diff for f.ts" })
    );
    expect(screen.getAllByText("Arrived during folding")).toHaveLength(2);
  });

  it("starts without annotations on either diff", () => {
    renderBoth();
    expect(codeViewItem().annotations).toEqual([]);
    expect(lastFileDiff().lineAnnotations).toEqual([]);
  });

  describe("multi-line selection", () => {
    // tool-1 adds X and Y (new lines 6 and 7).
    const TWO = filePatch({
      path: "f.ts",
      before: BASE,
      after: [...BASE.slice(0, 5), "X", "Y", ...BASE.slice(5)],
    });
    const twoFiles: WorktreeChange[] = [
      {
        path: "f.ts",
        old_path: null,
        status: "modified",
        marker: null,
        totals: { additions: 1, deletions: 1, binary_files: 0 },
        patch: TWO,
      },
    ];

    function renderTwo() {
      return render(
        <Harness>
          <PatchFiles patch={TWO} review={{ toolUseId: "tool-1" }} />
          <AllChangesView files={twoFiles} jumpTarget={null} onOpen={vi.fn()} />
        </Harness>
      );
    }
    const codeViewProps = () =>
      seen.codeView as unknown as {
        options: Record<string, unknown>;
        selectedLines: unknown;
        onSelectedLinesChange?: (selection: unknown) => void;
      };

    it("turns line selection on for both surfaces", () => {
      renderTwo();
      expect(lastFileDiff().options?.enableLineSelection).toBe(true);
      expect(codeViewProps().options.enableLineSelection).toBe(true);
      seen.fileDiffs.length = 0;
      render(<PatchFiles patch={TWO} />);
      expect(lastFileDiff().options?.enableLineSelection).toBeUndefined();
    });

    it("keeps a range highlighted while the comment composer is open", () => {
      renderTwo();

      const range = { start: 6, end: 7, side: "additions" };
      act(() =>
        (
          lastFileDiff().options as unknown as {
            onLineSelectionEnd: (r: unknown) => void;
          }
        ).onLineSelectionEnd(range)
      );
      expect(
        (lastFileDiff() as Props & { selectedLines?: unknown }).selectedLines
      ).toEqual(range);

      seen.range = range;
      fireEvent.click(screen.getByRole("button", { name: "gutter file diff" }));
      // Pierre echoes the completed selection right after the press.
      act(() =>
        (
          lastFileDiff().options as unknown as {
            onLineSelectionEnd: (r: unknown) => void;
          }
        ).onLineSelectionEnd(range)
      );
      expect(
        (lastFileDiff() as Props & { selectedLines?: unknown }).selectedLines
      ).toEqual(range);
      expect(lastFileDiff().lineAnnotations).toEqual([
        expect.objectContaining({
          lineNumber: 7,
          metadata: { commentIds: [], draft: true },
        }),
      ]);
    });

    it("comments on a dragged range as one comment shown on both diffs", () => {
      renderTwo();
      seen.range = { start: 6, end: 7, side: "additions" };
      addComment("gutter file diff", "Both lines?");
      const expected = [
        expect.objectContaining({ side: "additions", lineNumber: 7 }),
      ];
      expect(lastFileDiff().lineAnnotations).toEqual(expected);
      expect(codeViewItem().annotations).toEqual(expected);
      expect(screen.getAllByText(/f\.ts:6-7 \(new\)/)).toHaveLength(2);
    });

    it("keeps the All Changes selection while the composer is open", () => {
      renderTwo();

      const range = { start: 6, end: 7, side: "additions" };
      act(() => codeViewProps().onSelectedLinesChange?.({ id: "f.ts", range }));
      expect(codeViewProps().selectedLines).toEqual({ id: "f.ts", range });
      seen.range = range;
      fireEvent.click(screen.getByRole("button", { name: "gutter code view" }));

      expect(codeViewProps().selectedLines).toEqual({ id: "f.ts", range });

      fireEvent.change(
        screen.getByRole("textbox", { name: "New diff comment" }),
        { target: { value: "Keep this range" } }
      );
      fireEvent.click(screen.getByRole("button", { name: "Add comment" }));

      expect(codeViewProps().selectedLines).toBeNull();
    });

    it("clears a hidden file's selection and unsent composer on collapse", () => {
      renderTwo();
      const range = { start: 6, end: 7, side: "additions" };
      act(() => codeViewProps().onSelectedLinesChange?.({ id: "f.ts", range }));
      fireEvent.click(screen.getByRole("button", { name: "gutter code view" }));
      expect(
        screen.getByRole("textbox", { name: "New diff comment" })
      ).toBeVisible();
      fireEvent.click(
        screen.getByRole("button", { name: "Toggle diff for f.ts" })
      );
      expect(codeViewProps().selectedLines).toBeNull();
      expect(codeViewItem().annotations).toEqual([]);
      fireEvent.keyDown(
        screen.getAllByRole("group", { name: "Code diff selection" })[1],
        { key: "ArrowDown" }
      );
      expect(codeViewProps().selectedLines).toBeNull();
      fireEvent.click(
        screen.getByRole("button", { name: "Toggle diff for f.ts" })
      );
      expect(codeViewProps().selectedLines).toBeNull();
      expect(
        screen.queryByRole("textbox", { name: "New diff comment" })
      ).toBeNull();
    });

    it("keeps a reversed drag as a range", () => {
      renderTwo();
      seen.range = { start: 7, end: 6, side: "additions" };
      addComment("gutter file diff", "Both lines?");
      expect(screen.getAllByText(/f\.ts:6-7 \(new\)/)).toHaveLength(2);
    });

    it("keeps a range that crosses sides", () => {
      renderTwo();
      seen.range = {
        start: 5,
        side: "deletions",
        end: 7,
        endSide: "additions",
      };
      addComment("gutter file diff", "Context to Y");
      expect(screen.getAllByText(/f\.ts:5-7 \(new\)/)).toHaveLength(2);
    });
  });
});

describe("Changes keyboard line cursor", () => {
  const G = filePatch({ path: "g.ts", before: ["g1"], after: ["g1", "g2"] });
  const keyboardFiles: WorktreeChange[] = [
    worktreeFiles[0],
    { ...worktreeFiles[0], path: "g.ts", patch: G },
  ];
  const actions = {
    canAsk: true,
    select: vi.fn(),
    discuss: vi.fn(() => Promise.resolve(true)),
    attach: vi.fn(),
    reopen: vi.fn(),
    send: vi.fn(),
    cancel: vi.fn(),
    reconcile: vi.fn(),
  } satisfies DiscussionActions;
  const writeText = vi.fn(() => Promise.resolve());

  beforeEach(() => {
    seen.scrollTo.mockReset();
    seen.codeView = null;
    for (const action of Object.values(actions)) {
      if (typeof action === "function") action.mockClear();
    }
    writeText.mockClear();
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText },
    });
  });

  const onExit = vi.fn();
  const onEdge = vi.fn();

  function ViewedChanges({ diffStyle }: { diffStyle?: "unified" | "split" }) {
    const [viewed, setViewed] = useState<ReadonlySet<string>>(new Set());
    return (
      <AllChangesView
        files={keyboardFiles}
        jumpTarget={null}
        onOpen={vi.fn()}
        onExit={onExit}
        onEdge={onEdge}
        diffStyle={diffStyle}
        viewedPaths={viewed}
        onViewedChange={(path, value) =>
          setViewed((current) => {
            const next = new Set(current);
            if (value) next.add(path);
            else next.delete(path);
            return next;
          })
        }
      />
    );
  }

  function renderChanges(diffStyle?: "unified" | "split") {
    onExit.mockClear();
    onEdge.mockClear();
    render(
      <Harness>
        <SelectionDiscussionActionsContext.Provider value={actions}>
          <ViewedChanges diffStyle={diffStyle} />
        </SelectionDiscussionActionsContext.Provider>
      </Harness>
    );
    const group = screen.getByRole("group", { name: "Code diff selection" });
    act(() => group.focus());
    return group;
  }
  const selected = () =>
    (seen.codeView as unknown as { selectedLines: unknown }).selectedLines;
  const press = (key: string, init: Record<string, unknown> = {}) =>
    fireEvent.keyDown(document.activeElement!, { key, ...init });

  it("moves past the last line of a file to the first line of the next", () => {
    renderChanges();
    press("ArrowDown");
    expect(selected()).toEqual({
      id: "f.ts",
      range: { start: 3, end: 3, side: "additions" },
    });
    // f.ts shows lines 3-15 of the working tree (X inserted, l12 removed).
    for (let step = 0; step < 14; step++) press("ArrowDown");
    expect(selected()).toEqual({
      id: "g.ts",
      range: { start: 1, end: 1, side: "additions" },
    });
    expect(seen.scrollTo).toHaveBeenLastCalledWith(
      expect.objectContaining({ type: "line", id: "g.ts", lineNumber: 1 })
    );
  });

  it("copies an extended range as plain code", () => {
    renderChanges();
    press("ArrowDown");
    press("ArrowDown", { shiftKey: true });
    press("ArrowDown", { shiftKey: true });
    expect(selected()).toEqual({
      id: "f.ts",
      range: { start: 3, end: 5, side: "additions" },
    });
    press("c", { metaKey: true });
    expect(writeText).toHaveBeenCalledWith("l3\nl4\nl5");
  });

  it("starts the cursor from a focused file heading", () => {
    renderChanges();
    const heading = screen.getByRole("button", { name: "Toggle diff for g.ts" });
    act(() => heading.focus());
    press("ArrowDown");
    expect(selected()).toEqual({
      id: "g.ts",
      range: { start: 1, end: 1, side: "additions" },
    });
    expect(document.activeElement).toBe(
      screen.getByRole("group", { name: "Code diff selection" })
    );
  });

  it("opens a focused composer that discusses inline on ⌘↵", () => {
    renderChanges();
    press("ArrowDown");
    press("c");
    const input = screen.getByRole("textbox", { name: "New diff comment" });
    expect(document.activeElement).toBe(input);
    fireEvent.change(input, { target: { value: "Why?" } });
    fireEvent.keyDown(input, { key: "Enter", metaKey: true });
    expect(actions.discuss).toHaveBeenCalledWith(
      expect.objectContaining({ path: "f.ts", startLine: 3, endLine: 3 }),
      "Why?"
    );
    expect(actions.attach).not.toHaveBeenCalled();
  });

  it("sends the selection to the main chat on ⌘⇧↵", () => {
    renderChanges();
    press("ArrowDown");
    press("Enter");
    const input = screen.getByRole("textbox", { name: "New diff comment" });
    fireEvent.change(input, { target: { value: "Look here" } });
    fireEvent.keyDown(input, { key: "Enter", metaKey: true, shiftKey: true });
    expect(actions.attach).toHaveBeenCalledWith(
      expect.objectContaining({ path: "f.ts", startLine: 3 }),
      false,
      "Look here"
    );
    expect(actions.discuss).not.toHaveBeenCalled();
  });

  it("returns focus to the cursor line with the selection on Esc", async () => {
    const group = renderChanges();
    press("ArrowDown");
    press("ArrowDown", { shiftKey: true });
    press("c");
    // The composer ignores Pierre's echo of the opening selection for a tick.
    await act(() => new Promise((resolve) => setTimeout(resolve, 0)));
    fireEvent.keyDown(
      screen.getByRole("textbox", { name: "New diff comment" }),
      { key: "Escape" }
    );
    expect(
      screen.queryByRole("textbox", { name: "New diff comment" })
    ).toBeNull();
    expect(document.activeElement).toBe(group);
    expect(selected()).toEqual({
      id: "f.ts",
      range: { start: 3, end: 4, side: "additions" },
    });
    press("ArrowDown", { shiftKey: true });
    expect(selected()).toEqual({
      id: "f.ts",
      range: { start: 3, end: 5, side: "additions" },
    });
  });

  it("steps out with Esc: a range collapses, then focus leaves for the chat", () => {
    const group = renderChanges();
    expect(group).toHaveAttribute("data-owns-escape");
    press("ArrowDown");
    press("ArrowDown", { shiftKey: true });
    press("Escape");
    expect(selected()).toEqual({
      id: "f.ts",
      range: { start: 4, end: 4, side: "additions" },
    });
    expect(onExit).not.toHaveBeenCalled();
    press("Escape");
    expect(onExit).toHaveBeenCalledTimes(1);
    // The cursor survives leaving, so returning resumes it.
    expect(selected()).toEqual({
      id: "f.ts",
      range: { start: 4, end: 4, side: "additions" },
    });
  });

  it("continues in the main chat after sending a selection there", () => {
    renderChanges();
    press("ArrowDown");
    press("c");
    fireEvent.keyDown(
      screen.getByRole("textbox", { name: "New diff comment" }),
      { key: "Enter", metaKey: true, shiftKey: true }
    );
    expect(actions.attach).toHaveBeenCalled();
    expect(onExit).toHaveBeenCalledTimes(1);
  });

  it("keeps a context margin around the cursor when scrolling", () => {
    renderChanges();
    press("ArrowDown");
    expect(seen.scrollTo).toHaveBeenLastCalledWith(
      expect.objectContaining({ align: "nearest", offset: expect.any(Number) })
    );
  });

  it("jumps between files and hunks with ⌥↑/⌥↓ and ⌥⇧↑/⌥⇧↓", () => {
    renderChanges();
    press("ArrowDown", { altKey: true });
    expect(selected()).toEqual({
      id: "f.ts",
      range: { start: 3, end: 3, side: "additions" },
    });
    press("ArrowDown", { altKey: true });
    expect(selected()).toEqual({
      id: "g.ts",
      range: { start: 1, end: 1, side: "additions" },
    });
    press("ArrowUp", { altKey: true, shiftKey: true });
    expect(selected()).toEqual({
      id: "f.ts",
      range: { start: 3, end: 3, side: "additions" },
    });
  });

  it("leaves the diff with ←/→ past its outer column", () => {
    renderChanges("split");
    press("ArrowDown");
    // Additions column: → is the edge, ← switches column.
    press("ArrowRight");
    expect(onEdge).toHaveBeenLastCalledWith(1);
    press("ArrowLeft");
    expect(onEdge).toHaveBeenCalledTimes(1);
    expect(selected()).toEqual({
      id: "f.ts",
      range: { start: 3, end: 3, side: "deletions" },
    });
    press("ArrowLeft");
    expect(onEdge).toHaveBeenLastCalledWith(-1);
  });

  it("marks a file viewed with v, folds it and moves on", () => {
    renderChanges();
    press("ArrowDown");
    press("v");
    expect(selected()).toEqual({
      id: "g.ts",
      range: { start: 1, end: 1, side: "additions" },
    });
    expect(
      screen.getByRole("button", { name: "Toggle diff for f.ts" })
    ).toHaveAttribute("aria-expanded", "false");
    // The viewed file is skipped by the cursor.
    press("ArrowUp", { altKey: true });
    expect(selected()).toEqual({
      id: "g.ts",
      range: { start: 1, end: 1, side: "additions" },
    });
    // Unfolding a viewed file unmarks it.
    fireEvent.click(screen.getByRole("button", { name: "Toggle diff for f.ts" }));
    expect(
      screen.getByRole("button", { name: "Toggle diff for f.ts" })
    ).toHaveAttribute("aria-expanded", "true");
  });

  it("shows the composer bindings in its footer and tooltips", () => {
    renderChanges();
    press("ArrowDown");
    press("c");
    expect(
      screen.getByRole("button", { name: "Send to main chat" })
    ).toHaveAttribute("title", expect.stringMatching(/Send to main chat \(.+↵\)/));
    expect(
      screen.getByRole("button", { name: "Discuss inline" })
    ).toHaveAttribute("title", expect.stringMatching(/Discuss inline \(.+↵\)/));
  });
});

function AllChangesView(props: Omit<AllChangesViewProps, "parsedPatches">) {
  const parsedPatches = useMemo(
    () =>
      preparePatches({
        kind: "patch",
        patches: props.files.map((file) => (file.marker ? "" : file.patch)),
        review: true,
      }),
    [props.files]
  );

  return <AllChangesRenderer {...props} parsedPatches={parsedPatches} />;
}

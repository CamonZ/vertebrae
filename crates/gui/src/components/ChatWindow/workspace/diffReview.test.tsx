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
  }>;
  lineAnnotations?: Array<{
    side: string;
    lineNumber: number;
    metadata: unknown;
  }>;
  renderAnnotation?: (...args: unknown[]) => ReactNode;
}

const seen = vi.hoisted(() => ({
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
        renderHeaderMetadata(item: unknown): ReactNode;
        renderAnnotation?: (...args: unknown[]) => ReactNode;
      },
      ref
    ) {
      useImperativeHandle(ref, () => ({ scrollTo: vi.fn() }));
      seen.codeView = props as unknown as Record<string, unknown>;
      return (
        <div data-testid="code-view">
          {props.items.map((item) => (
            <div key={item.id}>
              <button
                type="button"
                onClick={() =>
                  props.options?.onGutterUtilityClick?.(seen.range, { item })
                }
              >
                gutter code view
              </button>
              {item.annotations?.map((annotation) => (
                <div key={`${annotation.side}${annotation.lineNumber}`}>
                  {props.renderAnnotation?.(annotation, item.fileDiff, item)}
                </div>
              ))}
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
}: {
  children: ReactNode;
  initial?: PendingComment[];
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
      focus: null,
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
  }, [comments, chain, worktree]);
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

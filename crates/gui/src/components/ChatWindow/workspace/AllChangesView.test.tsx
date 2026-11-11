import * as hegel from "@hegeldev/hegel";
import * as gs from "@hegeldev/hegel/generators";
import { cleanup } from "@testing-library/react";
import type { JumpTarget } from "./AllChangesView";
import { fireEvent, render, screen } from "@testing-library/react";
import {
  forwardRef,
  useImperativeHandle,
  useMemo,
  type ReactNode,
  type Ref,
} from "react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { CodeViewDiffItem } from "@pierre/diffs/react";
import AllChangesRenderer, { type AllChangesViewProps } from "./AllChangesView";
import { preparePatches } from "../../thread/toolChange/preparePatches";
import type { WorktreeChange } from "../../../bindings";

const scrollTo = vi.fn();
let renderedItems: readonly CodeViewDiffItem[] = [];
let renderedSelection: unknown;
let renderedDiffStyle: string | undefined;

// CodeView needs real layout; this stand-in records its items and scrolls.
vi.mock("@pierre/diffs/react", async (importOriginal) => {
  const original = await importOriginal<typeof import("@pierre/diffs/react")>();
  return {
    ...original,
    CodeView: forwardRef(function CodeView(
      props: {
        items: readonly CodeViewDiffItem[];
        options: { diffStyle?: string };
        selectedLines?: unknown;
        renderCustomHeader(item: CodeViewDiffItem): ReactNode;
        renderCodeViewHeader?(): ReactNode;
        containerRef?: Ref<HTMLDivElement>;
      },
      ref
    ) {
      useImperativeHandle(ref, () => ({ scrollTo }));
      renderedItems = props.items;
      renderedSelection = props.selectedLines;
      renderedDiffStyle = props.options.diffStyle;
      return (
        <div ref={props.containerRef}>
          {props.renderCodeViewHeader?.()}
          {props.items.map((item) => (
            <div key={item.id}>{props.renderCustomHeader(item)}</div>
          ))}
        </div>
      );
    }),
  };
});

const patch = (path: string) =>
  `diff --git a/${path} b/${path}\n--- a/${path}\n+++ b/${path}\n@@ -1 +1 @@\n-a\n+b\n`;
const files: WorktreeChange[] = [
  {
    path: "a.ts",
    old_path: null,
    status: "modified",
    marker: null,
    totals: { additions: 1, deletions: 1, binary_files: 0 },
    patch: patch("a.ts"),
  },
  {
    path: "image.png",
    old_path: null,
    status: "added",
    marker: "binary",
    totals: { additions: 1, deletions: 1, binary_files: 0 },
    patch: "",
  },
  {
    path: "mode.sh",
    old_path: null,
    status: "modified",
    marker: null,
    totals: { additions: 1, deletions: 1, binary_files: 0 },
    patch: "",
  },
];

const containerScroll = vi.fn();
beforeEach(() => {
  scrollTo.mockReset();
  containerScroll.mockReset();
  HTMLElement.prototype.scrollTo =
    containerScroll as unknown as HTMLElement["scrollTo"];
});

describe("AllChangesView", () => {
  it("virtualizes text diffs and lists fallbacks above them", () => {
    const onOpen = vi.fn();
    render(<AllChangesView files={files} jumpTarget={null} onOpen={onOpen} />);
    expect(renderedItems.map((item) => item.id)).toEqual(["a.ts"]);
    expect(renderedItems[0]?.fileDiff.isPartial).toBe(true);
    expect(screen.getByText("Binary file — diff not shown")).toBeVisible();
    expect(
      screen.getByText("No text hunks (mode or metadata change).")
    ).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Open a.ts" }));
    expect(onOpen).toHaveBeenCalledExactlyOnceWith("a.ts");
  });

  it("scrolls once per jump request to diffs and fallbacks", () => {
    const view = render(
      <AllChangesView
        files={files}
        jumpTarget={{ path: "a.ts", nonce: 1 }}
        onOpen={vi.fn()}
      />
    );
    expect(scrollTo).toHaveBeenCalledExactlyOnceWith({
      type: "item",
      id: "a.ts",
      align: "start",
    });
    view.rerender(
      <AllChangesView
        files={[...files]}
        jumpTarget={{ path: "a.ts", nonce: 1 }}
        onOpen={vi.fn()}
      />
    );
    expect(scrollTo).toHaveBeenCalledTimes(1);
    view.rerender(
      <AllChangesView
        files={files}
        jumpTarget={{ path: "image.png", nonce: 2 }}
        onOpen={vi.fn()}
      />
    );
    expect(scrollTo).toHaveBeenCalledTimes(1);
    expect(containerScroll).toHaveBeenCalledExactlyOnceWith({
      top: 0,
      behavior: "auto",
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

it("passes a workspace layout change to Pierre while preserving prepared diff items", () => {
  const props = { files, jumpTarget: null, onOpen: vi.fn() };
  const { rerender } = render(
    <AllChangesView {...props} diffStyle="unified" />
  );
  expect(renderedDiffStyle).toBe("unified");
  const diff = renderedItems[0].fileDiff;
  rerender(<AllChangesView {...props} diffStyle="split" />);
  expect(renderedDiffStyle).toBe("split");
  expect(renderedItems[0].fileDiff).toBe(diff);
});

const twoTextFiles = [
  files[0],
  { ...files[0], path: "b.ts", patch: patch("b.ts") },
];

it.each(["unified", "split"] as const)(
  "folds headings independently in %s layout with keyboard support",
  async (diffStyle) => {
    const user = userEvent.setup();
    const onOpen = vi.fn();
    render(
      <AllChangesView
        files={twoTextFiles}
        jumpTarget={null}
        onOpen={onOpen}
        diffStyle={diffStyle}
      />
    );
    const heading = screen.getByRole("button", {
      name: "Toggle diff for a.ts",
    });
    expect(heading).toHaveAttribute("aria-expanded", "true");
    const version = renderedItems[0].version!;
    await user.click(heading);
    expect(heading).toHaveAttribute("aria-expanded", "false");
    expect(renderedItems.map((item) => item.collapsed)).toEqual([true, false]);
    expect(renderedItems[0].version).toBeGreaterThan(version);
    await user.click(screen.getByRole("button", { name: "Open a.ts" }));
    expect(onOpen).toHaveBeenCalledExactlyOnceWith("a.ts");
    expect(heading).toHaveAttribute("aria-expanded", "false");
    heading.focus();
    await user.keyboard("{Enter}");
    expect(heading).toHaveAttribute("aria-expanded", "true");
    await user.keyboard(" ");
    expect(heading).toHaveAttribute("aria-expanded", "false");
  }
);

it("retains folds on refresh and layout changes, discards removed paths, and expands jumps before scrolling", () => {
  const props = { files: twoTextFiles, jumpTarget: null, onOpen: vi.fn() };
  const view = render(<AllChangesView {...props} diffStyle="unified" />);
  fireEvent.click(screen.getByRole("button", { name: "Toggle diff for a.ts" }));
  const version = renderedItems[0].version!;
  view.rerender(
    <AllChangesView {...props} files={[...twoTextFiles]} diffStyle="split" />
  );
  expect(renderedItems[0].collapsed).toBe(true);
  expect(renderedItems[0].version).toBeGreaterThan(version);
  scrollTo.mockImplementation(() =>
    expect(renderedItems[0].collapsed).toBe(false)
  );
  view.rerender(
    <AllChangesView {...props} jumpTarget={{ path: "a.ts", nonce: 1 }} />
  );
  expect(scrollTo).toHaveBeenCalledTimes(1);
  fireEvent.click(screen.getByRole("button", { name: "Toggle diff for a.ts" }));
  // The already-handled jump must not reopen a file during refresh.
  view.rerender(
    <AllChangesView
      {...props}
      files={[...twoTextFiles]}
      jumpTarget={{ path: "a.ts", nonce: 1 }}
    />
  );
  expect(renderedItems[0].collapsed).toBe(true);
  view.rerender(<AllChangesView {...props} files={[twoTextFiles[1]]} />);
  view.rerender(<AllChangesView {...props} />);
  expect(renderedItems.map((item) => item.collapsed)).toEqual([false, false]);
});

it("folds every parsed item belonging to one file together", () => {
  render(
    <AllChangesView
      files={[{ ...files[0], patch: patch("a.ts") + patch("other.ts") }]}
      jumpTarget={null}
      onOpen={vi.fn()}
    />
  );
  fireEvent.click(
    screen.getAllByRole("button", { name: "Toggle diff for a.ts" })[0]
  );
  expect(renderedItems).toHaveLength(2);
  expect(renderedItems.map((item) => item.collapsed)).toEqual([true, true]);
});

it("jumps to an evidence line range after unfolding a file", () => {
  const view = render(
    <AllChangesView files={files} jumpTarget={null} onOpen={vi.fn()} />
  );
  fireEvent.click(screen.getByRole("button", { name: "Toggle diff for a.ts" }));
  view.rerender(
    <AllChangesView
      files={files}
      jumpTarget={{ path: "a.ts", line: 1, endLine: 2, side: "old", nonce: 4 }}
      onOpen={vi.fn()}
    />
  );
  expect(renderedItems[0].collapsed).toBe(false);
  expect(renderedSelection).toEqual({
    id: "a.ts",
    range: { start: 1, end: 2, side: "deletions" },
  });
  expect(scrollTo).toHaveBeenLastCalledWith({
    type: "line",
    id: "a.ts",
    lineNumber: 1,
    side: "deletions",
    align: "center",
  });
});

it("matches the navigation model across generated jump, fold, refresh and reopen sequences", () =>
  hegel.test(
    (tc) => {
      const actions = tc.draw(
        gs.arrays(
          gs.record({
            kind: gs.sampledFrom([
              "jump",
              "fold",
              "refresh",
              "reopen",
            ] as const),
            path: gs.sampledFrom(["a.ts", "b.ts"]),
            side: gs.sampledFrom(["old", "new"] as const),
            line: gs.integers({ minValue: 1, maxValue: 20 }),
            length: gs.integers({ minValue: 0, maxValue: 10 }),
          }),
          { minSize: 1, maxSize: 25 }
        )
      );
      // Oracle tracks user intent only: folds, current request, and expected scrolls.
      let target: JumpTarget | null = null;
      let nonce = 0;
      const folded = new Set<string>();
      const expectedScrolls: unknown[] = [];
      scrollTo.mockReset();
      const props = () => ({
        files: [...twoTextFiles],
        jumpTarget: target,
        onOpen: vi.fn(),
      });
      let view = render(<AllChangesView {...props()} />);
      const expectJump = (request: JumpTarget) => {
        folded.delete(request.path);
        expectedScrolls.push([
          {
            type: "line",
            id: request.path,
            lineNumber: request.line,
            side: request.side === "old" ? "deletions" : "additions",
            align: "center",
          },
        ]);
      };
      try {
        for (const action of actions) {
          switch (action.kind) {
            case "jump":
              target = {
                path: action.path,
                line: action.line,
                endLine: action.line + action.length,
                side: action.side,
                nonce: ++nonce,
              };
              expectJump(target);
              view.rerender(<AllChangesView {...props()} />);
              break;
            case "fold":
              if (folded.has(action.path)) folded.delete(action.path);
              else folded.add(action.path);
              fireEvent.click(
                screen.getByRole("button", {
                  name: `Toggle diff for ${action.path}`,
                })
              );
              break;
            case "refresh":
              view.rerender(<AllChangesView {...props()} />);
              break;
            case "reopen":
              view.unmount();
              folded.clear();
              if (target) expectJump(target);
              view = render(<AllChangesView {...props()} />);
              break;
          }
          expect(scrollTo.mock.calls, JSON.stringify(actions)).toEqual(
            expectedScrolls
          );
          for (const item of renderedItems)
            expect(item.collapsed).toBe(folded.has(item.id));
          if (target)
            expect(renderedSelection).toEqual({
              id: target.path,
              range: {
                start: target.line,
                end: target.endLine,
                side: target.side === "old" ? "deletions" : "additions",
              },
            });
        }
      } finally {
        cleanup();
      }
    },
    { testCases: 60 }
  ));

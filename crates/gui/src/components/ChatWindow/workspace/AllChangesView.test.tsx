import { fireEvent, render, screen } from "@testing-library/react";
import {
  forwardRef,
  useImperativeHandle,
  useMemo,
  type ReactNode,
  type Ref,
} from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { CodeViewDiffItem } from "@pierre/diffs/react";
import AllChangesRenderer, { type AllChangesViewProps } from "./AllChangesView";
import { preparePatches } from "../../thread/toolChange/preparePatches";
import type { WorktreeChange } from "../../../bindings";

const scrollTo = vi.fn();
let renderedItems: readonly CodeViewDiffItem[] = [];

// CodeView needs real layout; this stand-in records its items and scrolls.
vi.mock("@pierre/diffs/react", async (importOriginal) => {
  const original = await importOriginal<typeof import("@pierre/diffs/react")>();
  return {
    ...original,
    CodeView: forwardRef(function CodeView(
      props: {
        items: readonly CodeViewDiffItem[];
        renderHeaderMetadata(item: CodeViewDiffItem): ReactNode;
        renderCodeViewHeader?(): ReactNode;
        containerRef?: Ref<HTMLDivElement>;
      },
      ref
    ) {
      useImperativeHandle(ref, () => ({ scrollTo }));
      renderedItems = props.items;
      return (
        <div ref={props.containerRef}>
          {props.renderCodeViewHeader?.()}
          {props.items.map((item) => (
            <div key={item.id}>{props.renderHeaderMetadata(item)}</div>
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
    patch: patch("a.ts"),
  },
  {
    path: "image.png",
    old_path: null,
    status: "added",
    marker: "binary",
    patch: "",
  },
  {
    path: "mode.sh",
    old_path: null,
    status: "modified",
    marker: null,
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

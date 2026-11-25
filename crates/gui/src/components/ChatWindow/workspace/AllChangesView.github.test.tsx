import { act, fireEvent, render, screen, within } from "@testing-library/react";
import {
  forwardRef,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  type ReactNode,
  type Ref,
} from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CodeViewDiffItem } from "@pierre/diffs/react";
import AllChangesRenderer from "./AllChangesView";
import { preparePatches } from "../../thread/toolChange/preparePatches";
import type { WorktreeChange } from "../../../bindings";
import { useChatSideColumnStore } from "../../../stores/chatSideColumnStore";
import { buildReviewModel, type GithubReviewModel } from "./githubReview/model";
import { anchored, at, outdated, reviewThread } from "./githubReview/fixture";
import { useReviewController } from "./githubReview/useReviewController";

const scrollTo = vi.fn();
/** Redraw an item's rows when its annotations change, as Pierre does. */
const pierre = { redraws: false };

function drawRows(root: ShadowRoot) {
  const code = document.createElement("div");
  code.setAttribute("data-code", "");
  code.setAttribute("data-unified", "");
  const content = document.createElement("div");
  content.setAttribute("data-content", "");
  for (let line = 1; line <= 30; line++) {
    for (const side of [0, 1]) {
      const row = document.createElement("div");
      row.setAttribute("data-line", String(line));
      row.setAttribute("data-line-index", `${line},${side}`);
      row.textContent = `line ${line}`;
      content.append(row);
    }
  }
  code.append(content);
  root.replaceChildren(code);
}

// CodeView needs real layout; this stand-in draws each item's code rows in a
// shadow root (as Pierre does), its header and its annotations, and calls
// onPostRender after each render.
vi.mock("@pierre/diffs/react", async (importOriginal) => {
  const original = await importOriginal<typeof import("@pierre/diffs/react")>();
  return {
    ...original,
    CodeView: forwardRef(function CodeView(
      props: {
        items: readonly CodeViewDiffItem<{ commentIds: string[] }>[];
        options: { onPostRender?(node: HTMLElement, instance: unknown): void };
        renderCustomHeader(
          item: CodeViewDiffItem<{ commentIds: string[] }>
        ): ReactNode;
        renderAnnotation?(...args: unknown[]): ReactNode;
        containerRef?: Ref<HTMLDivElement>;
      },
      ref
    ) {
      const instances = useMemo(() => new Map<string, object>(), []);
      const hosts = useMemo(() => new Map<string, HTMLElement>(), []);
      const signatures = useMemo(() => new Map<string, string>(), []);
      const mountRows = (id: string, host: HTMLElement | null) => {
        if (!host) return;
        hosts.set(id, host);
        if (host.shadowRoot) return;
        drawRows(host.attachShadow({ mode: "open" }));
      };
      const listed = useMemo(() => new Set<string>(), []);
      const all = () =>
        props.items.map((item) => {
          if (!instances.has(item.id))
            instances.set(item.id, {
              getLineIndex: (line: number, side: string) => [
                line,
                side === "additions" ? 1 : 0,
              ],
            });
          return {
            id: item.id,
            type: "diff",
            item,
            instance: instances.get(item.id),
            element: hosts.get(item.id) ?? document.body,
          };
        });
      useImperativeHandle(ref, () => ({
        scrollTo,
        getInstance: () => ({
          getRenderedItems: () => all().filter((item) => listed.has(item.id)),
        }),
      }));
      useEffect(() => {
        if (pierre.redraws)
          for (const item of props.items) {
            const drawn = JSON.stringify(item.annotations ?? []);
            const root = hosts.get(item.id)?.shadowRoot;
            if (root && signatures.get(item.id) !== drawn) drawRows(root);
            signatures.set(item.id, drawn);
          }
        const items = all();
        for (const item of items)
          props.options.onPostRender?.(document.body, item.instance);
        for (const item of items) listed.add(item.id);
      });
      return (
        <div ref={props.containerRef}>
          {props.items.map((item) => (
            <section key={item.id} aria-label={`diff ${item.id}`}>
              <div data-test-rows="" ref={(node) => mountRows(item.id, node)} />
              {props.renderCustomHeader(item)}
              {!item.collapsed &&
                item.annotations?.map((annotation) => (
                  <div key={`${annotation.side}:${annotation.lineNumber}`}>
                    {props.renderAnnotation?.(annotation, item.fileDiff, item)}
                  </div>
                ))}
            </section>
          ))}
        </div>
      );
    }),
  };
});

const PATH = "src/lib.rs";
const patch =
  "diff --git a/src/lib.rs b/src/lib.rs\n--- a/src/lib.rs\n+++ b/src/lib.rs\n@@ -10,7 +10,7 @@\n a();\n b();\n c();\n-let total = 1;\n+let total = 2;\n d();\n e();\n f();\n";
const files: WorktreeChange[] = [
  {
    path: PATH,
    old_path: null,
    status: "modified",
    marker: null,
    totals: { additions: 1, deletions: 1, binary_files: 0 },
    patch,
  },
];
const CHANGES = { sessionId: "session", worktreePath: "/work/demo-repo" };

function model(): GithubReviewModel {
  return buildReviewModel(
    7,
    [
      reviewThread("t1", { author: "alice", body: "Why 2?" }),
      reviewThread("t2", { author: "bob", body: "Needs a test." }),
      reviewThread("t3", { line: 15, originalLine: 14, body: "Rename this." }),
      reviewThread("first", {
        line: 10,
        originalLine: 10,
        resolved: true,
        body: "Settled.\nMore detail.",
      }),
      reviewThread("old", {
        outdated: true,
        line: null,
        originalLine: 9,
        body: "Stale note.",
      }),
    ],
    [
      at("t1", anchored(13)),
      at("t2", anchored(13)),
      at("t3", anchored(15, 14)),
      at("first", anchored(10)),
      at("old", outdated(9)),
    ],
    false
  );
}

function View({
  review,
  label = "pane",
}: {
  review: GithubReviewModel;
  label?: string;
}) {
  const pane = useRef<HTMLDivElement>(null);
  const parsedPatches = useMemo(
    () =>
      preparePatches({
        kind: "patch",
        patches: files.map((file) => file.patch),
        review: true,
      }),
    []
  );
  const { diff } = useReviewController(review, pane, () => false);
  return (
    <div ref={pane} tabIndex={-1} role="group" aria-label={label}>
      <AllChangesRenderer
        files={files}
        parsedPatches={parsedPatches}
        jumpTarget={null}
        onOpen={() => {}}
        chatChanges={CHANGES}
        github={diff}
      />
    </div>
  );
}

async function renderView() {
  const review = model();
  const view = render(<View review={review} />);
  await act(async () => {});
  return view;
}

function shadow(scope: HTMLElement = document.body) {
  return within(scope)
    .getByRole("region", { name: `diff ${PATH}` })
    .querySelector("[data-test-rows]")!.shadowRoot!;
}

function marker(line: number, scope?: HTMLElement) {
  return shadow(scope).querySelector<HTMLButtonElement>(
    `[data-line-index="${line},1"] [data-gh-marker]`
  );
}

function cards(scope: HTMLElement = document.body) {
  return within(scope).queryAllByRole("region", {
    name: /^GitHub thread from/,
  });
}

beforeEach(() => {
  scrollTo.mockReset();
  pierre.redraws = false;
  useChatSideColumnStore.getState().forget();
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
    callback(0);
    return 0;
  });
  vi.stubGlobal("cancelAnimationFrame", () => {});
});
afterEach(() => vi.unstubAllGlobals());

describe("GitHub review threads in Changes", () => {
  it("stacks two threads on one line into one marker; Esc returns to it", async () => {
    await renderView();
    const rows = shadow().querySelectorAll("[data-gh-marker]");
    expect(rows).toHaveLength(3);
    // Every drawn line gets the lane, so markers read as one column.
    expect(shadow().querySelectorAll("[data-gh-marker-rail]")).toHaveLength(60);
    const stacked = marker(13)!;
    expect(stacked).toHaveAccessibleName(
      "2 GitHub threads from alice, bob on line 13"
    );
    // Generated content only: the line's text is untouched.
    expect(stacked.closest("[data-line]")).toHaveTextContent(/^line 13$/);
    expect(stacked).toHaveAttribute("aria-expanded", "false");

    await act(async () => fireEvent.click(stacked));
    expect(cards()).toHaveLength(2);
    expect(screen.getByText("Why 2?")).toBeInTheDocument();
    expect(screen.getByText("Needs a test.")).toBeInTheDocument();
    expect(screen.getByText("thread 1 of 2")).toBeInTheDocument();
    expect(cards()[0]).toHaveFocus();
    expect(marker(13)).toHaveAttribute("aria-expanded", "true");

    await act(async () => fireEvent.keyDown(cards()[0], { key: "Escape" }));
    expect(cards()).toHaveLength(1);
    expect(marker(13)!.getRootNode()).toHaveProperty(
      "activeElement",
      marker(13)
    );
    // The closed thread's line is kept in view, never scrolled away from.
    expect(scrollTo).toHaveBeenLastCalledWith(
      expect.objectContaining({
        type: "line",
        lineNumber: 13,
        align: "nearest",
      })
    );
  });

  it("gives focus back to the marker after Pierre redraws its row", async () => {
    pierre.redraws = true;
    await renderView();
    await act(async () => fireEvent.click(marker(15)!));
    expect(cards()[0]).toHaveFocus();
    await act(async () => fireEvent.keyDown(cards()[0], { key: "Escape" }));
    expect(cards()).toHaveLength(0);
    expect(marker(15)!.getRootNode()).toHaveProperty(
      "activeElement",
      marker(15)
    );
  });

  it("marks a thread moved by local edits and explains it", async () => {
    await renderView();
    const moved = marker(15)!;
    expect(moved).toHaveAccessibleName(
      "1 GitHub thread from alice on line 15, anchor moved by local edits"
    );
    expect(moved.querySelector('[data-gh-drift="moved"]')).not.toBeNull();
    await act(async () => fireEvent.click(moved));
    expect(cards()[0]).toHaveTextContent(
      "Published on line 14; your local edits moved it 1 line down. GitHub re-anchors after you push."
    );
  });

  it("lists outdated threads from the file's Outdated pill", async () => {
    await renderView();
    const pill = screen.getByRole("button", { name: /^Outdated 1/ });
    await act(async () => fireEvent.click(pill));
    const group = screen.getByRole("group", {
      name: `Outdated GitHub threads in ${PATH}`,
    });
    const card = within(group).getByRole("region");
    expect(card).toHaveTextContent("outdated · was line 9");
    expect(card).toHaveTextContent("Stale note.");
    expect(
      within(card).getByLabelText("Code as originally commented")
    ).toHaveTextContent("let x = 0;");
    expect(pill).toHaveAttribute("aria-expanded", "true");
    await act(async () => fireEvent.keyDown(card, { key: "Escape" }));
    expect(
      screen.queryByRole("group", { name: /Outdated GitHub threads/ })
    ).toBeNull();
    expect(pill).toHaveFocus();
  });

  it("opens the threads at the cursor line with o, and stops ⌥↓ at them", async () => {
    useChatSideColumnStore
      .getState()
      .saveChanges(CHANGES.sessionId, CHANGES.worktreePath, {
        cursor: {
          path: PATH,
          range: { start: 11, end: 11, side: "additions" },
        },
      });
    await renderView();
    const group = screen.getByRole("group", { name: "Code diff selection" });
    await act(async () =>
      fireEvent.keyDown(group, { key: "ArrowDown", altKey: true })
    );
    expect(
      useChatSideColumnStore.getState().bySession[CHANGES.sessionId]?.changes[
        CHANGES.worktreePath
      ]?.cursor?.range
    ).toMatchObject({ start: 13, end: 13 });
    await act(async () => fireEvent.keyDown(group, { key: "o" }));
    expect(cards()).toHaveLength(2);
    expect(cards()[0]).toHaveFocus();
  });

  it("shows a line's threads and the file's outdated threads in one slot", async () => {
    await renderView();
    await act(async () => fireEvent.click(marker(10)!));
    await act(async () =>
      fireEvent.click(screen.getByRole("button", { name: /^Outdated 1/ }))
    );
    expect(
      screen.getByRole("group", { name: "GitHub threads on line 10" })
    ).toBeInTheDocument();
    expect(
      screen.getByRole("group", { name: `Outdated GitHub threads in ${PATH}` })
    ).toBeInTheDocument();
  });

  it("folds a resolved thread to its first line until shown", async () => {
    await renderView();
    await act(async () => fireEvent.click(marker(10)!));
    const [card] = cards();
    expect(card).toHaveTextContent("alice: Settled.");
    expect(
      within(card).queryByText("More detail.", { exact: false })
    ).toBeNull();
    const show = within(card).getByRole("button", { name: "Show" });
    expect(show).toHaveAttribute("aria-expanded", "false");
    await act(async () => fireEvent.click(show));
    expect(within(card).getByRole("button", { name: "Hide" })).toHaveAttribute(
      "aria-expanded",
      "true"
    );
    expect(card).toHaveTextContent("More detail.");
  });

  it("gives focus back inside its own pane when two panes show the diff", async () => {
    const review = model();
    render(
      <>
        <View review={review} label="left" />
        <View review={review} label="right" />
      </>
    );
    await act(async () => {});
    const left = screen.getByRole("group", { name: "left" });
    const right = screen.getByRole("group", { name: "right" });
    await act(async () => fireEvent.click(marker(15, right)!));
    expect(cards(left)).toHaveLength(0);
    await act(async () =>
      fireEvent.keyDown(cards(right)[0], { key: "Escape" })
    );
    expect(cards(right)).toHaveLength(0);
    expect(marker(15, right)!.getRootNode()).toHaveProperty(
      "activeElement",
      marker(15, right)
    );
    expect(marker(15, left)!.getRootNode()).toHaveProperty(
      "activeElement",
      null
    );
  });
});

import { act, fireEvent, render, screen, within } from "@testing-library/react";
import {
  forwardRef,
  useEffect,
  useImperativeHandle,
  useMemo,
  type ReactNode,
  type Ref,
} from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CodeViewDiffItem } from "@pierre/diffs/react";
import AllChangesRenderer, { type AllChangesViewProps } from "./AllChangesView";
import { preparePatches } from "../../thread/toolChange/preparePatches";
import { parsePatch } from "../../thread/toolChange/diffLineMapper";
import type {
  ChangeSides,
  SemanticOutcome,
  WorktreeChange,
} from "../../../bindings";

const scrollTo = vi.fn();

// CodeView needs real layout; this stand-in renders headers and annotations
// and calls onPostRender for each item. Like Pierre, it lists an item as
// rendered only after that item's first onPostRender.
vi.mock("@pierre/diffs/react", async (importOriginal) => {
  const original = await importOriginal<typeof import("@pierre/diffs/react")>();
  return {
    ...original,
    CodeView: forwardRef(function CodeView(
      props: {
        items: readonly CodeViewDiffItem<{ commentIds: string[] }>[];
        options: { onPostRender?(node: HTMLElement, instance: unknown): void };
        renderCustomHeader(item: CodeViewDiffItem<{ commentIds: string[] }>): ReactNode;
        renderAnnotation?(...args: unknown[]): ReactNode;
        containerRef?: Ref<HTMLDivElement>;
      },
      ref
    ) {
      const instances = useMemo(() => new Map<string, object>(), []);
      const listed = useMemo(() => new Set<string>(), []);
      const all = () =>
        props.items.map((item) => {
          if (!instances.has(item.id)) instances.set(item.id, {});
          return { id: item.id, type: "diff", item, instance: instances.get(item.id), element: document.body };
        });
      const rendered = () => all().filter((item) => listed.has(item.id));
      useImperativeHandle(ref, () => ({
        scrollTo,
        getInstance: () => ({ getRenderedItems: rendered }),
      }));
      useEffect(() => {
        const items = all();
        for (const item of items) props.options.onPostRender?.(document.body, item.instance);
        for (const item of items) listed.add(item.id);
      });
      return (
        <div ref={props.containerRef}>
          {props.items.map((item) => (
            <section
              key={item.id}
              aria-label={`diff ${item.id}`}
              data-version={item.version}
            >
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

const change = (path: string, patch: string): WorktreeChange => ({
  path,
  old_path: null,
  status: "modified",
  marker: null,
  totals: { additions: 1, deletions: 1, binary_files: 0 },
  patch,
});

const tsPatch =
  "diff --git a/f.ts b/f.ts\n--- a/f.ts\n+++ b/f.ts\n@@ -12,7 +12,7 @@\n   a();\n   b();\n   c();\n-  count += 1;\n+  count += 2;\n   d();\n   e();\n   f();\n";
const mdPatch = "diff --git a/notes.md b/notes.md\n--- a/notes.md\n+++ b/notes.md\n@@ -1 +1 @@\n-a\n+b\n";
const fmtPatch =
  "diff --git a/fmt.rs b/fmt.rs\n--- a/fmt.rs\n+++ b/fmt.rs\n@@ -1,1 +1,3 @@\n-fn a() { 1 }\n+fn a() {\n+    1\n+}\n";

const results: Record<string, SemanticOutcome> = {
  "f.ts": {
    status: "semantic",
    language: "typescript",
    declarations: [
      {
        scope: [],
        subject: {
          kind: "function",
          keyword: "function",
          name: "f",
          old_line: 10,
          new_line: 10,
        },
        change: { kind: "modified" },
        facts: { items: [], omitted: 0 },
        parts: [
          {
            kind: "changed",
            old: { start: 15, end: 15 },
            new: { start: 15, end: 15 },
            facts: { items: [], omitted: 0 },
          },
        ],
      },
    ],
  },
  "notes.md": { status: "fallback", reason: "unsupported_language" },
  "fmt.rs": { status: "semantic", language: "rust", declarations: [] },
};

/** Both sides as the patch shows them (other lines blank), and the diff. */
function sides(patch: string, semantic: SemanticOutcome | null): ChangeSides {
  const old: string[] = [];
  const next: string[] = [];
  for (const hunk of parsePatch(patch)[0].hunks)
    for (const row of hunk.rows) {
      if (row.oldLine !== null) old[row.oldLine - 1] = row.text;
      if (row.newLine !== null) next[row.newLine - 1] = row.text;
    }
  const text = (lines: string[]) => ({
    kind: "text" as const,
    contents: `${Array.from(lines, (line) => line ?? "").join("\n")}\n`,
    revision: "r",
  });
  return { old: text(old), new: text(next), semantic };
}

/** A loader answering semantic requests with `outcome(change)`. */
const loader =
  (outcome: (change: WorktreeChange) => Promise<SemanticOutcome>) =>
  async (change: WorktreeChange, semantic: boolean) =>
    sides(change.patch, semantic ? await outcome(change) : null);

function AllChangesView(
  props: Omit<AllChangesViewProps, "parsedPatches" | "jumpTarget" | "onOpen">
) {
  const parsedPatches = useMemo(
    () =>
      preparePatches({
        kind: "patch",
        patches: props.files.map((file) => file.patch),
        review: true,
      }),
    [props.files]
  );
  return (
    <AllChangesRenderer {...props} parsedPatches={parsedPatches} jumpTarget={null} onOpen={() => {}} />
  );
}

const files = [
  change("f.ts", tsPatch),
  change("notes.md", mdPatch),
  change("fmt.rs", fmtPatch),
];
const load = vi.fn(loader((file) => Promise.resolve(results[file.path])));

beforeEach(() => {
  load.mockClear();
  scrollTo.mockReset();
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
    callback(0);
    return 0;
  });
  vi.stubGlobal("cancelAnimationFrame", () => {});
});
afterEach(() => vi.unstubAllGlobals());

async function renderSemantic(enabled = true) {
  const view = render(
    <AllChangesView files={files} loadSides={load} semantic={enabled} />
  );
  await act(async () => {});
  return view;
}

describe("AllChangesView semantic mode", () => {
  it("labels a change with its enclosing function", async () => {
    await renderSemantic();
    const diff = screen.getByRole("region", { name: "diff f.ts" });
    expect(diff).toHaveTextContent("function f");
    expect(diff).toHaveTextContent("changed");
    // One request per file and patch, however often it renders.
    expect(load.mock.calls.map(([file]) => file.path).sort()).toEqual(["f.ts", "fmt.rs", "notes.md"]);
  });

  it("marks each file header pending until its semantic result arrives", async () => {
    let resolve: (file: SemanticOutcome) => void = () => {};
    const slow = vi.fn(
      loader(() => new Promise<SemanticOutcome>((done) => (resolve = done)))
    );
    const { container } = render(
      <AllChangesView
        files={[change("f.ts", tsPatch)]}
        loadSides={slow}
        semantic
      />
    );
    const heading = () => container.querySelector('[data-changes-path="f.ts"]');
    // Requested from the first render alone, before any interaction.
    await act(async () => {});
    expect(slow).toHaveBeenCalledTimes(1);
    expect(heading()).toHaveAttribute("data-semantic", "pending");
    await act(async () => resolve(results["f.ts"]));
    expect(heading()).toHaveAttribute("data-semantic", "ready");
  });

  it("marks files kept as a line diff, with the reason", async () => {
    await renderSemantic();
    const marker = screen.getByText("line diff");
    expect(marker).toHaveAttribute("title", "Language not supported for semantic diff");
    expect(screen.getByRole("region", { name: "diff notes.md" })).toContainElement(marker);
  });

  it("keeps the line diff when the file changed since its patch, or the request failed", async () => {
    const edited = async (
      file: WorktreeChange,
      semantic: boolean
    ): Promise<ChangeSides> => {
      if (file.path === "notes.md") throw new Error("boom");
      const read = sides(file.patch, semantic ? results[file.path] : null);
      return {
        ...read,
        new: { kind: "text", contents: "edited since\n", revision: "r2" },
      };
    };
    render(
      <AllChangesView files={files.slice(0, 2)} loadSides={edited} semantic />
    );
    await act(async () => {});
    const marker = (path: string) =>
      within(screen.getByRole("region", { name: `diff ${path}` })).getByText(
        "line diff"
      );
    expect(marker("f.ts")).toHaveAttribute(
      "title",
      "The file changed since this diff was loaded"
    );
    expect(marker("notes.md")).toHaveAttribute(
      "title",
      "Semantic diff failed: Error: boom"
    );
    expect(screen.queryByText("function")).toBeNull();
  });

  it("folds a whitespace-only file behind a formatting marker, which the toggle opens and folds by hand", async () => {
    await renderSemantic();
    const toggle = screen.getByRole("button", { name: "Toggle diff for fmt.rs" });
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    expect(screen.getByRole("region", { name: "diff fmt.rs" })).toHaveTextContent("formatting only");
    fireEvent.click(toggle);
    expect(toggle).toHaveAttribute("aria-expanded", "true");
    fireEvent.click(toggle);
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    fireEvent.click(toggle);
    expect(toggle).toHaveAttribute("aria-expanded", "true");
  });

  it("opens a viewed file by unmarking it", async () => {
    const onViewedChange = vi.fn();
    render(
      <AllChangesView
        files={files}
        loadSides={load}
        semantic
        viewedPaths={new Set(["f.ts"])}
        onViewedChange={onViewedChange}
      />
    );
    await act(async () => {});
    const toggle = screen.getByRole("button", { name: "Toggle diff for f.ts" });
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    fireEvent.click(toggle);
    expect(onViewedChange).toHaveBeenCalledWith("f.ts", false);
  });

  it("re-versions only the file whose result arrived", async () => {
    const pending = new Map<string, (file: SemanticOutcome) => void>();
    const deferred = loader(
      (file) =>
        new Promise<SemanticOutcome>((done) => pending.set(file.path, done))
    );
    render(<AllChangesView files={files} loadSides={deferred} semantic />);
    await act(async () => {});
    const version = (path: string) =>
      screen
        .getByRole("region", { name: `diff ${path}` })
        .getAttribute("data-version");
    await act(async () => pending.get("f.ts")!(results["f.ts"]));
    const settled = version("f.ts");
    await act(async () => pending.get("notes.md")!(results["notes.md"]));
    expect(version("f.ts")).toBe(settled);
    expect(version("notes.md")).not.toBe("0");
  });

  it("asks for no semantic diff and labels nothing in line mode", async () => {
    await renderSemantic(false);
    expect(load.mock.calls.every(([, semantic]) => !semantic)).toBe(true);
    expect(
      document.querySelector('[data-changes-path="f.ts"]')
    ).toHaveAttribute("data-semantic", "off");
    expect(screen.queryByText("function")).toBeNull();
    expect(screen.queryByText("line diff")).toBeNull();
    expect(screen.getByRole("button", { name: "Toggle diff for fmt.rs" })).toHaveAttribute(
      "aria-expanded",
      "true"
    );
  });

  it("drops and restores the semantic view when switching modes", async () => {
    const view = await renderSemantic();
    const fmt = () =>
      screen.getByRole("button", { name: "Toggle diff for fmt.rs" });
    const labelled = () =>
      screen.getByRole("region", { name: "diff f.ts" }).textContent;
    expect(labelled()).toContain("function f");
    expect(fmt()).toHaveAttribute("aria-expanded", "false");

    view.rerender(
      <AllChangesView files={files} loadSides={load} semantic={false} />
    );
    await act(async () => {});
    expect(labelled()).not.toContain("function f");
    expect(fmt()).toHaveAttribute("aria-expanded", "true");

    view.rerender(<AllChangesView files={files} loadSides={load} semantic />);
    await act(async () => {});
    expect(labelled()).toContain("function f");
    expect(fmt()).toHaveAttribute("aria-expanded", "false");
  });

  it("links a moved copy to the other location", async () => {
    const movePatch =
      "diff --git a/m.rs b/m.rs\n--- a/m.rs\n+++ b/m.rs\n@@ -1,3 +1,0 @@\n-fn a() {\n-    1\n-}\n@@ -9,1 +6,4 @@\n }\n+fn a() {\n+    1\n+}\n";
    const moved: SemanticOutcome = {
      status: "semantic",
      language: "rust",
      declarations: [
        {
          scope: [],
          subject: {
            kind: "function",
            keyword: "fn",
            name: "a",
            old_line: 1,
            new_line: 7,
          },
          change: {
            kind: "moved",
            old: { start: 1, end: 3 },
            new: { start: 7, end: 9 },
          },
          facts: { items: [], omitted: 0 },
          parts: [],
        },
      ],
    };
    render(
      <AllChangesView
        files={[change("m.rs", movePatch)]}
        loadSides={loader(() => Promise.resolve(moved))}
        semantic
      />
    );
    await act(async () => {});
    fireEvent.click(screen.getByRole("button", { name: "moved fn a from L1 ↗" }));
    expect(scrollTo).toHaveBeenCalledWith({
      type: "line",
      id: "m.rs",
      lineNumber: 1,
      side: "deletions",
      align: "center",
    });
    expect(screen.getByRole("region", { name: "diff m.rs" })).toHaveTextContent("1 moved");
    expect(screen.getByLabelText("Declarations: moved fn a")).toBeInTheDocument();
  });
});

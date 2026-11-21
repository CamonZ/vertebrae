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
  ChangedSymbols,
  CodeSymbol,
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
      const hosts = useMemo(() => new Map<string, HTMLElement>(), []);
      const mountGutter = (id: string, host: HTMLElement | null) => {
        if (!host) return;
        hosts.set(id, host);
        if (host.shadowRoot) return;
        const root = host.attachShadow({ mode: "open" });
        const code = document.createElement("div");
        code.setAttribute("data-code", "");
        code.setAttribute("data-unified", "");
        const gutter = document.createElement("div");
        gutter.setAttribute("data-gutter", "");
        for (let line = 1; line <= 30; line++) {
          for (const side of [0, 1]) {
            const row = document.createElement("div");
            row.setAttribute("data-column-number", String(line));
            row.setAttribute("data-line-index", `${line},${side}`);
            gutter.append(row);
          }
        }
        code.append(gutter);
        root.append(code);
      };
      const listed = useMemo(() => new Set<string>(), []);
      const all = () =>
        props.items.map((item) => {
          if (!instances.has(item.id)) {
            instances.set(item.id, {
              getLineIndex: (line: number, side: string) => [line, side === "additions" ? 1 : 0],
            });
          }
          return { id: item.id, type: "diff", item, instance: instances.get(item.id), element: hosts.get(item.id) ?? document.body };
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
              <div data-test-gutter="" ref={(node) => mountGutter(item.id, node)} />
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

async function renderSemantic() {
  const view = render(<AllChangesView files={files} loadSides={load} />);
  await act(async () => {});
  return view;
}

function indicator(path: string, side: "old" | "new", line: number) {
  return screen.getByRole("region", { name: `diff ${path}` })
    .querySelector("[data-test-gutter]")?.shadowRoot
    ?.querySelector<HTMLButtonElement>(`button[aria-label^="Semantic details for ${side} line ${line}"]`);
}

describe("AllChangesView semantic data", () => {
  it("labels a change with its enclosing function", async () => {
    await renderSemantic();
    const diff = screen.getByRole("region", { name: "diff f.ts" });
    expect(diff).not.toHaveTextContent("function f");
    const button = indicator("f.ts", "new", 15)!;
    expect(button).toHaveAttribute("aria-expanded", "false");
    fireEvent.click(button);
    expect(button).toHaveAttribute("aria-expanded", "true");
    expect(diff).toHaveTextContent("function f");
    const details = within(diff).getByRole("region", { name: "Semantic details" });
    expect(details).toHaveFocus();
    fireEvent.keyDown(details, { key: "Escape" });
    expect(diff).not.toHaveTextContent("function f");
    expect(button.getRootNode()).toHaveProperty("activeElement", button);
    expect(diff).not.toHaveTextContent("changed");
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

  it("shows a file without semantic data as its plain line diff", async () => {
    await renderSemantic();
    const notes = screen.getByRole("region", { name: "diff notes.md" });
    expect(notes).not.toHaveTextContent("line diff");
    expect(notes.querySelector("[data-test-gutter]")?.shadowRoot?.querySelector("button")).toBeFalsy();
  });

  it("labels nothing when the file changed since its patch, or the request failed", async () => {
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
      <AllChangesView files={files.slice(0, 2)} loadSides={edited} />
    );
    await act(async () => {});
    expect(indicator("f.ts", "new", 15)).toBeFalsy();
    expect(screen.queryByText("line diff")).toBeNull();
    expect(screen.queryByText("function")).toBeNull();
  });

  it("marks a whitespace-only file as formatting only, without folding it", async () => {
    await renderSemantic();
    const toggle = screen.getByRole("button", { name: "Toggle diff for fmt.rs" });
    expect(toggle).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByRole("region", { name: "diff fmt.rs" })).toHaveTextContent("formatting only");
    fireEvent.click(toggle);
    expect(toggle).toHaveAttribute("aria-expanded", "false");
  });

  it("opens a viewed file by unmarking it", async () => {
    const onViewedChange = vi.fn();
    render(
      <AllChangesView
        files={files}
        loadSides={load}
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
    render(<AllChangesView files={files} loadSides={deferred} />);
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

  it("labels nothing without a way to read the sides", async () => {
    render(<AllChangesView files={files} />);
    await act(async () => {});
    expect(
      document.querySelector('[data-changes-path="f.ts"]')
    ).toHaveAttribute("data-semantic", "off");
    expect(screen.queryByText("function")).toBeNull();
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
      />
    );
    await act(async () => {});
    fireEvent.click(indicator("m.rs", "new", 7)!);
    fireEvent.click(screen.getByRole("button", { name: "moved fn a from L1 ↗" }));
    expect(scrollTo).toHaveBeenCalledWith({
      type: "line",
      id: "m.rs",
      lineNumber: 1,
      side: "deletions",
      align: "center",
    });
    expect(screen.getByRole("region", { name: "diff m.rs" })).toHaveTextContent("1 moved");
    fireEvent.click(indicator("m.rs", "old", 1)!);
    fireEvent.click(screen.getByRole("button", { name: "moved fn a to L7 ↗" }));
    expect(scrollTo).toHaveBeenLastCalledWith({
      type: "line",
      id: "m.rs",
      lineNumber: 7,
      side: "additions",
      align: "center",
    });
    expect(screen.getByLabelText("Declarations: moved fn a")).toBeInTheDocument();
  });
});

it("links the current hunk to an ambiguous changed-symbol candidate", async () => {
  const path = "target.ts";
  const patch = "diff --git a/target.ts b/target.ts\n--- a/target.ts\n+++ b/target.ts\n@@ -1 +1 @@\n-function target() { return 1; }\n+function target() { return 2; }\n";
  const source = results["f.ts"];
  if (source.status !== "semantic") throw new Error("expected semantic fixture");
  const origin = source.declarations[0];
  const makeSymbol = (path: string, name: string, line: number): CodeSymbol => ({
    path, name, line, kind: "function", scope: [], span: { start: line, end: line },
  });
  const target = makeSymbol(path, "target", 1);
  const caller = makeSymbol("f.ts", "f", 10);
  const declarations = [
    origin,
    {
      ...origin,
      subject: { kind: "function" as const, name: target.name, keyword: "function", old_line: 1, new_line: 1 },
      parts: [{
        kind: "changed" as const, old: target.span, new: target.span, facts: origin.facts,
      }],
    },
  ];
  const comparison: ChangedSymbols = {
    provider: "embedded",
    incomplete: false,
    symbols: [caller, target].map((symbol, i) => ({
      id: { path: symbol.path, scope: [symbol.name], kind: symbol.kind, occurrence: 0 },
      change: "modified",
      edits: [{
        path: symbol.path, old_path: symbol.path, index: 0,
        old_revision: "r", new_revision: "r", declaration: declarations[i],
      }],
      effects: [],
    })),
    calls: [{
      side: "new", changed_caller: 0, changed_targets: [1], effect: null, callee_effects: [],
      call: {
        caller, callee: target.name, site: { path: caller.path, line: 15, column: 1 },
        resolution: { quality: "ambiguous", candidates: [target, makeSymbol("another.ts", "target", 1)] },
      },
    }],
  };
  const jump = vi.fn();
  let resolveGraph!: (graph: ChangedSymbols) => void;
  const graph = new Promise<ChangedSymbols>((resolve) => { resolveGraph = resolve; });
  const changedFiles = [files[0], change(path, patch)];
  const loadSides = loader((file) => Promise.resolve({
    ...source, declarations: [declarations[file.path === path ? 1 : 0]],
  }));
  const view = (load: () => Promise<ChangedSymbols>) => (
    <AllChangesView
      files={changedFiles}
      loadSides={loadSides}
      symbolGraphRequest={{ key: "current-comparison", load }}
      onRelatedJump={jump}
    />
  );
  const initialLoad = vi.fn(() => graph);
  const refreshLoad = vi.fn(() => graph);
  const { rerender } = render(view(initialLoad));
  const originDiff = screen.getByRole("region", { name: "diff f.ts" });
  await act(async () => {});
  fireEvent.click(indicator("f.ts", "new", 15)!);
  expect(within(originDiff).getByText("f")).toBeVisible();
  const initialVersion = originDiff.getAttribute("data-version");
  rerender(view(refreshLoad));
  await act(async () => resolveGraph(comparison));
  expect(initialLoad).toHaveBeenCalledTimes(1);
  expect(refreshLoad).not.toHaveBeenCalled();
  expect(originDiff.getAttribute("data-version")).not.toBe(initialVersion);
  const link = within(originDiff).getByRole("button", { name: /Calls target.*ambiguous/ });
  fireEvent.click(link);
  expect(jump).toHaveBeenCalledWith({ path, line: 1, side: "new" });
  const targetDiff = screen.getByRole("region", { name: `diff ${path}` });
  fireEvent.click(indicator(path, "new", 1)!);
  expect(within(targetDiff).getByRole("button", { name: /Called by f.*ambiguous/ })).toBeVisible();
});

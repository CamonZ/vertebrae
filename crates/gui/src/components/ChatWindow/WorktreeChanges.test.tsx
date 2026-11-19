import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WorktreeChanges } from "./WorktreeChanges";
import { useWorktreeWatch } from "./workspace/useWorktreeWatch";
import {
  commands,
  type FileBody,
  type WorktreeChanges as Changes,
} from "../../bindings";
import { useDocumentStore } from "./workspace/documentStore";
import { useCommandPaletteStore } from "../../stores/commandPaletteStore";
import {
  SelectionDiscussionContext,
  type DiscussionValue,
} from "./selectionDiscussionState";
import {
  DISCUSSION_ASK_SHORTCUT,
  DISCUSSION_COLLAPSE_SHORTCUT,
  DISCUSSION_SEND_SHORTCUT,
  shortcutText,
} from "./chatShortcuts";
import type { AllChangesViewProps } from "./workspace/AllChangesView";
import type { DocumentEditorProps } from "./workspace/DocumentEditor";

vi.mock("./workspace/useWorktreeWatch", () => ({
  useWorktreeWatch: vi.fn(() => null),
}));

vi.mock("../../bindings", () => ({
  commands: {
    loadWorktreeChanges: vi.fn(),
    openLocalFile: vi.fn().mockResolvedValue({ status: "ok", data: null }),
    listComparisonChoices: vi
      .fn()
      .mockResolvedValue({ status: "ok", data: [] }),
    listWorktreeDirectory: vi.fn(),
    worktreeFileExists: vi.fn().mockResolvedValue({ status: "ok", data: true }),
    readWorktreeFile: vi.fn(),
    readWorktreeBaselineFile: vi.fn(),
    saveWorktreeFile: vi.fn(),
  },
}));
// Pierre stand-ins: the editor captures its contents at mount like the real one.
vi.mock("./workspace/AllChangesView", () => ({
  default: function AllDiffs({
    files,
    jumpTarget,
    onOpen,
    diffStyle,
    onExit,
    loadContents,
  }: AllChangesViewProps) {
    const [folded, setFolded] = useState(false);
    // Stand-in for the cursor resting on collapsed lines.
    const [onGap, setOnGap] = useState(false);
    const [contents, setContents] = useState("");
    return (
      <div data-testid="all-diffs" data-layout={diffStyle}>
        <div
          role="group"
          aria-label="Code diff selection"
          tabIndex={0}
          data-diff-cursor-host=""
          data-line-cursor={onGap ? "gap" : ""}
          onKeyDown={(event) => {
            if (event.key === "Escape") onExit?.();
            if (event.key === "ArrowDown") setOnGap((value) => !value);
          }}
        />
        <button
          type="button"
          onClick={() =>
            void loadContents?.(files[0]).then((loaded) =>
              setContents(loaded ? loaded.newFile.contents : "none")
            )
          }
        >
          Load contents
        </button>
        <output aria-label="Loaded contents">{contents}</output>
        <button aria-expanded={!folded} onClick={() => setFolded(!folded)}>
          Test fold
        </button>
        {files.map((file) => (
          <section key={file.path} aria-label={`Diff for ${file.path}`}>
            <pre>{file.marker ?? file.patch}</pre>
            <button type="button" onClick={() => onOpen(file.path)}>
              Open diff {file.path}
            </button>
          </section>
        ))}
        <output aria-label="Jump target">{jumpTarget?.path ?? ""}</output>
      </div>
    );
  },
}));
vi.mock("./workspace/DocumentEditor", () => ({
  default: ({
    path,
    view,
    contents,
    baseline,
    onChange,
    diffStyle,
    reveal,
    onRevealed,
  }: DocumentEditorProps) => (
    <div
      data-testid="document-editor"
      data-layout={diffStyle}
      data-reveal={reveal ? `${reveal.line}-${reveal.endLine}` : ""}
      data-scrolled={reveal?.scrolled ? "true" : "false"}
    >
      {reveal && !reveal.scrolled && (
        <button type="button" onClick={() => onRevealed?.()}>
          Finish reveal
        </button>
      )}
      <p>
        {view} editor for {path}
      </p>
      {baseline != null && <pre aria-label="Baseline contents">{baseline}</pre>}
      {contents == null ? (
        <p>Deleted file</p>
      ) : (
        <textarea
          aria-label={`Edit ${path}`}
          defaultValue={contents}
          onChange={(event) => onChange(event.target.value)}
        />
      )}
    </div>
  ),
}));

const load = vi.mocked(commands.loadWorktreeChanges);
const list = vi.mocked(commands.listWorktreeDirectory);
const read = vi.mocked(commands.readWorktreeFile);
const readBaseline = vi.mocked(commands.readWorktreeBaselineFile);
const save = vi.mocked(commands.saveWorktreeFile);

const empty: Changes = {
  base_branch: "refs/heads/main",
  base_unavailable: null,
  comparison: {
    base_commit: "base-sha",
    selected_base_commit: "base-sha",
    target_commit: "head-sha",
    working_tree: true,
    merge_base: true,
  },
  totals: { additions: 2, deletions: 2, binary_files: 0 },
  files: [],
};
const modified: Changes = {
  ...empty,
  files: [
    {
      path: "src/app.ts",
      old_path: null,
      status: "modified",
      marker: null,
      totals: { additions: 1, deletions: 1, binary_files: 0 },
      patch:
        "diff --git a/src/app.ts b/src/app.ts\n--- a/src/app.ts\n+++ b/src/app.ts\n@@ -1 +1 @@\n-old\n+new\n",
    },
    {
      path: "gone.txt",
      old_path: null,
      status: "deleted",
      marker: null,
      totals: { additions: 1, deletions: 1, binary_files: 0 },
      patch:
        "diff --git a/gone.txt b/gone.txt\n--- a/gone.txt\n+++ /dev/null\n@@ -1 +0,0 @@\n-bye\n",
    },
  ],
};
const text = (contents: string, revision: string): FileBody => ({
  kind: "text",
  contents,
  revision,
});
let disk: Record<string, FileBody>;

beforeEach(() => {
  useDocumentStore.setState({ workspaces: {} });
  load.mockReset();
  load.mockResolvedValue({ status: "ok", data: empty });
  disk = {
    "src/app.ts": text("unchanged line\nnew\n", "r1"),
    "src/util.ts": text("export {};\n", "u1"),
    "gone.txt": { kind: "missing" },
  };
  list.mockReset();
  list.mockImplementation(async (_worktree, path) => ({
    status: "ok",
    data: {
      path,
      truncated: false,
      entries:
        path === ""
          ? [
              { name: "src", path: "src", kind: "directory", symlink: false },
              {
                name: "README.md",
                path: "README.md",
                kind: "file",
                symlink: false,
              },
            ]
          : [
              {
                name: "app.ts",
                path: "src/app.ts",
                kind: "file",
                symlink: false,
              },
              {
                name: "util.ts",
                path: "src/util.ts",
                kind: "file",
                symlink: false,
              },
            ],
    },
  }));
  read.mockReset();
  read.mockImplementation(async (_worktree, path) => ({
    status: "ok",
    data: disk[path] ?? text(`${path} contents\n`, "x"),
  }));
  readBaseline.mockReset();
  readBaseline.mockImplementation(async (_worktree, path) => ({
    status: "ok",
    data:
      path === "src/app.ts"
        ? text("unchanged line\nold\n", "b1")
        : text("bye\n", "b2"),
  }));
  save.mockReset();
  save.mockImplementation(async (_worktree, path, contents) => {
    disk[path] = text(contents, `saved:${contents}`);
    return {
      status: "ok",
      data: { kind: "saved", revision: `saved:${contents}` },
    };
  });
});
afterEach(() => {
  vi.useRealTimers();
});

async function openChangedFile() {
  load.mockResolvedValue({ status: "ok", data: modified });
  const view = render(<WorktreeChanges worktreePath="/worktree" />);
  fireEvent.click(
    await screen.findByRole("button", { name: "Open diff src/app.ts" })
  );
  await screen.findByRole("textbox", { name: "Edit src/app.ts" });
  return view;
}

function selectComparison(control: HTMLElement, value: string) {
  fireEvent.click(control);
  const option = screen
    .getAllByRole("option")
    .find((item) => item.getAttribute("data-value") === value);
  if (!option) throw new Error(`Missing comparison option: ${value}`);
  fireEvent.click(option);
}

/** ⌘K from `from`, then run the Changes palette command labelled `label`. */
async function runChangesCommand(from: HTMLElement, label: string) {
  fireEvent.keyDown(from, { key: "k", metaKey: true });
  const palette = useCommandPaletteStore.getState();
  expect(palette.open).toBe(true);
  expect(palette.scope).toBe("changes");
  const item = palette.contextItems.find((entry) => entry.label === label);
  if (!item) throw new Error(`Missing Changes command: ${label}`);
  await act(async () => {
    palette.closePalette();
    await item.run();
    await new Promise((resolve) => requestAnimationFrame(resolve));
  });
}

it("opens the changed-file list and wraps keyboard jumps without capturing editor input", async () => {
  await openChangedFile();
  const editor = screen.getByRole("textbox", { name: "Edit src/app.ts" });
  editor.focus();
  expect(fireEvent.keyDown(editor, { key: "/" })).toBe(true);
  expect(fireEvent.keyDown(editor, { key: "v" })).toBe(true);
  expect(useCommandPaletteStore.getState().open).toBe(false);
  expect(editor).toHaveFocus();

  fireEvent.click(screen.getByRole("button", { name: "Hide files" }));
  const changes = screen.getByRole("region", { name: "Worktree changes" });
  changes.focus();
  await runChangesCommand(changes, "Show file list");
  const row = screen.getByRole("button", { name: "Jump to src/app.ts" });
  expect(row).toHaveFocus();

  const nextFile = { key: "ArrowDown", altKey: true, shiftKey: true };
  fireEvent.keyDown(row, nextFile);
  const jump = await screen.findByLabelText("Jump target");
  expect(jump).toHaveTextContent("gone.txt");
  fireEvent.keyDown(row, nextFile);
  expect(jump).toHaveTextContent("src/app.ts");
  fireEvent.keyDown(row, { ...nextFile, key: "ArrowUp" });
  expect(jump).toHaveTextContent("gone.txt");
});

it("moves focus with the arrow keys inside the changed-file list", async () => {
  load.mockResolvedValue({ status: "ok", data: modified });
  render(<WorktreeChanges worktreePath="/worktree" />);
  const first = await screen.findByRole("button", { name: "Jump to src/app.ts" });
  const last = screen.getByRole("button", { name: "Jump to gone.txt" });
  const changes = screen.getByRole("region", { name: "Worktree changes" });
  changes.focus();
  expect(fireEvent.keyDown(changes, { key: "ArrowDown" })).toBe(true);
  await runChangesCommand(changes, "Show file list");
  expect(first).toHaveFocus();
  expect(last).toHaveAttribute("tabindex", "-1");

  expect(fireEvent.keyDown(first, { key: "ArrowDown" })).toBe(false);
  expect(last).toHaveFocus();
  expect(first).toHaveAttribute("tabindex", "-1");
  expect(last).toHaveAttribute("tabindex", "0");
  fireEvent.keyDown(last, { key: "ArrowDown", repeat: true });
  expect(last).toHaveFocus();
  fireEvent.keyDown(last, { key: "ArrowUp" });
  expect(first).toHaveFocus();
  fireEvent.keyDown(first, { key: "ArrowUp" });
  expect(first).toHaveFocus();
});

it("opens the focused file in Pierre or the configured external editor", async () => {
  load.mockResolvedValue({ status: "ok", data: modified });
  render(<WorktreeChanges worktreePath="/worktree" />);
  const row = await screen.findByRole("button", { name: "Jump to src/app.ts" });
  act(() => row.focus());

  await runChangesCommand(row, "Open full diff");
  await screen.findByText("diff editor for src/app.ts");
  const changes = screen.getByRole("region", { name: "Worktree changes" });

  await runChangesCommand(changes, "Open full file");
  await screen.findByText("file editor for src/app.ts");
  await runChangesCommand(changes, "Open in external editor");
  expect(commands.openLocalFile).toHaveBeenCalledWith(
    "/worktree",
    "src/app.ts",
    null,
    null,
    null
  );
});

describe("WorktreeChanges", () => {
  it("retains the diff component on background refresh and resets it for comparison/worktree changes", async () => {
    load.mockResolvedValue({ status: "ok", data: modified });
    const view = render(<WorktreeChanges worktreePath="/worktree" />);
    const fold = await screen.findByRole("button", { name: "Test fold" });
    fireEvent.click(fold);
    const calls = vi.mocked(useWorktreeWatch).mock.calls;
    act(() => calls[calls.length - 1][1]());
    await waitFor(() => expect(load).toHaveBeenCalledTimes(2));
    expect(screen.getByRole("button", { name: "Test fold" })).toHaveAttribute(
      "aria-expanded",
      "false"
    );
    selectComparison(
      screen.getByRole("combobox", { name: "Comparison base" }),
      "head"
    );
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Test fold" })).toHaveAttribute(
        "aria-expanded",
        "true"
      )
    );
    fireEvent.click(screen.getByRole("button", { name: "Test fold" }));
    view.rerender(<WorktreeChanges worktreePath="/another" />);
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Test fold" })).toHaveAttribute(
        "aria-expanded",
        "true"
      )
    );
  });

  it("defaults to the whole branch on open and refresh and can select Uncommitted", async () => {
    render(<WorktreeChanges worktreePath="/worktree" />);
    expect(screen.getByText("Loading changes…")).toHaveAttribute(
      "role",
      "status"
    );
    expect(screen.queryByText("/worktree")).toBeNull();
    expect(
      screen.getByRole("button", { name: "Refresh changes" })
    ).toBeDisabled();
    await screen.findByText("No changes against this baseline.");
    expect(load).toHaveBeenCalledExactlyOnceWith("/worktree", {
      base: null,
      target: { kind: "working_tree" },
      merge_base: true,
    });
    fireEvent.click(screen.getByRole("button", { name: "Refresh changes" }));
    await waitFor(() => expect(load).toHaveBeenCalledTimes(2));
    await screen.findByText("No changes against this baseline.");
    selectComparison(screen.getByLabelText("Comparison base"), "head");
    await waitFor(() =>
      expect(load).toHaveBeenLastCalledWith("/worktree", {
        base: { kind: "head" },
        target: { kind: "working_tree" },
        merge_base: false,
      })
    );
  });

  it("renders every file and uses the collapsible sidebar only to jump", async () => {
    load.mockResolvedValue({
      status: "ok",
      data: {
        ...empty,
        files: [
          {
            path: "new",
            old_path: "old",
            status: "renamed",
            marker: null,
            totals: { additions: 1, deletions: 1, binary_files: 0 },
            patch:
              "diff --git a/old b/new\n--- a/old\n+++ b/new\n@@ -1 +1 @@\n-before\n+after\n",
          },
          {
            path: "binary",
            old_path: null,
            status: "added",
            marker: "binary",
            totals: { additions: 1, deletions: 1, binary_files: 0 },
            patch: "",
          },
        ],
      },
    });
    render(<WorktreeChanges worktreePath="/worktree" />);
    await screen.findByRole("button", { name: "Jump to new" });
    await screen.findByText(/\+after/);
    expect(screen.getByRole("region", { name: "Diff for new" })).toBeVisible();
    expect(
      screen.getByRole("region", { name: "Diff for binary" })
    ).toBeVisible();
    expect(
      screen.getByRole("button", { name: "Jump to new" })
    ).toHaveTextContent("+1−1");
    expect(
      screen.getByRole("button", { name: "Jump to new" })
    ).toHaveTextContent("from old");
    fireEvent.click(screen.getByRole("button", { name: "Jump to binary" }));
    expect(
      screen.getByRole("status", { name: "Jump target" })
    ).toHaveTextContent("binary");
    expect(
      screen.getByRole("button", { name: "Jump to binary" })
    ).toHaveAttribute("aria-current", "location");
    fireEvent.click(screen.getByRole("button", { name: "Hide files" }));
    expect(
      screen.queryByRole("navigation", { name: "Changed files" })
    ).toBeNull();
    expect(screen.getByRole("region", { name: "Diff for new" })).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Show files" }));
    expect(
      screen.getByRole("navigation", { name: "Changed files" })
    ).toBeVisible();
    expect(load).toHaveBeenCalledTimes(1);
  });

  it("keeps an unavailable whole-branch baseline distinct from empty success and permits recovery", async () => {
    load.mockImplementation(async (_worktree, request) =>
      request.merge_base
        ? {
            status: "error",
            error: {
              message:
                "Whole-branch baseline is unavailable; select Uncommitted.",
            },
          }
        : {
            status: "ok",
            data: {
              ...empty,
              base_branch: null,
              base_unavailable: "No base branch",
            },
          }
    );
    render(<WorktreeChanges worktreePath="/missing" />);
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Whole-branch baseline is unavailable"
    );
    expect(screen.queryByRole("status", { name: "No changes" })).toBeNull();
    const baseline = screen.getByRole("combobox", { name: "Comparison base" });
    expect(baseline).toHaveValue("auto");
    expect(baseline).toBeEnabled();
    selectComparison(baseline, "head");
    expect(
      await screen.findByRole("status", { name: "No changes" })
    ).toBeVisible();
    expect(await screen.findByText("No base branch")).toBeVisible();
    expect(screen.queryByRole("alert")).toBeNull();
    expect(baseline).toHaveValue("head");
  });

  it("shows committed branch changes by default even when Uncommitted is empty", async () => {
    load.mockImplementation(async (_worktree, request) => ({
      status: "ok",
      data: request.merge_base ? modified : empty,
    }));
    render(<WorktreeChanges worktreePath="/worktree" />);
    await screen.findByRole("region", { name: "Diff for src/app.ts" });
    const baseline = screen.getByRole("combobox", { name: "Comparison base" });
    expect(baseline).toHaveValue("auto");
    expect(
      screen.getByRole("combobox", { name: "Comparison base" })
    ).toBeInTheDocument();
    expect(screen.queryByRole("status", { name: "No changes" })).toBeNull();
    selectComparison(baseline, "head");
    expect(
      await screen.findByRole("status", { name: "No changes" })
    ).toBeVisible();
    expect(
      screen.queryByRole("region", { name: "Diff for src/app.ts" })
    ).toBeNull();
    expect(baseline).toBeEnabled();
    selectComparison(baseline, "auto");
    await screen.findByRole("region", { name: "Diff for src/app.ts" });
    expect(screen.queryByRole("status", { name: "No changes" })).toBeNull();
    expect(load).toHaveBeenLastCalledWith("/worktree", {
      base: null,
      target: { kind: "working_tree" },
      merge_base: true,
    });
  });

  it("renders valid empty states for both baselines and responds to filesystem changes", async () => {
    render(<WorktreeChanges worktreePath="/worktree" />);
    const baseline = screen.getByRole("combobox", { name: "Comparison base" });
    // The initial selection is valid before Git discovers the base branch.
    expect(baseline).toHaveValue("auto");
    expect(
      await screen.findByRole("status", { name: "No changes" })
    ).toBeVisible();
    expect(screen.queryByRole("alert")).toBeNull();
    selectComparison(baseline, "head");
    await waitFor(() =>
      expect(load).toHaveBeenLastCalledWith("/worktree", {
        base: { kind: "head" },
        target: { kind: "working_tree" },
        merge_base: false,
      })
    );
    expect(
      await screen.findByRole("status", { name: "No changes" })
    ).toBeVisible();
    const calls = vi.mocked(useWorktreeWatch).mock.calls;
    const refresh = calls[calls.length - 1][1];
    load.mockResolvedValue({ status: "ok", data: modified });
    act(() => refresh());
    await screen.findByRole("region", { name: "Diff for src/app.ts" });
    expect(baseline).toHaveValue("head");
    expect(screen.queryByRole("status", { name: "No changes" })).toBeNull();
    load.mockResolvedValue({ status: "ok", data: empty });
    act(() => refresh());
    expect(
      await screen.findByRole("status", { name: "No changes" })
    ).toBeVisible();
    expect(
      screen.queryByRole("region", { name: "Diff for src/app.ts" })
    ).toBeNull();
    expect(screen.queryByRole("alert")).toBeNull();
    expect(baseline).toBeEnabled();
  });

  it("drops late failures after worktree changes", async () => {
    let resolveOld!: (value: Awaited<ReturnType<typeof load>>) => void;
    load.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveOld = resolve;
        })
    );
    const view = render(<WorktreeChanges worktreePath="/old" />);
    view.rerender(<WorktreeChanges worktreePath="/new" />);
    await screen.findByText("No changes against this baseline.");
    await act(async () =>
      resolveOld({ status: "error", error: { message: "stale error" } })
    );
    expect(screen.queryByRole("alert")).toBeNull();
    expect(load).toHaveBeenLastCalledWith("/new", {
      base: null,
      target: { kind: "working_tree" },
      merge_base: true,
    });
  });

  it("browses folders lazily with status decorations and opens full files", async () => {
    load.mockResolvedValue({ status: "ok", data: modified });
    render(<WorktreeChanges worktreePath="/worktree" />);
    fireEvent.click(screen.getByRole("button", { name: "Files" }));
    const tree = screen.getByRole("navigation", { name: "Worktree files" });
    const folder = await within(tree).findByRole("button", { name: /src/ });
    expect(list).toHaveBeenCalledExactlyOnceWith("/worktree", "");
    expect(folder).toHaveAttribute("aria-expanded", "false");
    await waitFor(() =>
      expect(folder).toHaveAccessibleName(/\(contains changes\)/)
    );
    fireEvent.click(folder);
    const changed = await within(tree).findByRole("button", {
      name: /app\.ts/,
    });
    expect(list).toHaveBeenLastCalledWith("/worktree", "src");
    expect(changed).toHaveTextContent("M");
    fireEvent.click(within(tree).getByRole("button", { name: /util\.ts/ }));
    expect(
      await screen.findByRole("textbox", { name: "Edit src/util.ts" })
    ).toHaveValue("export {};\n");
    expect(screen.getByText("file editor for src/util.ts")).toBeVisible();
    expect(screen.queryByRole("group", { name: "Document view" })).toBeNull();
    fireEvent.click(changed);
    await screen.findByText("file editor for src/app.ts");
    expect(
      screen.getByRole("textbox", { name: "Edit src/app.ts" })
    ).toHaveValue("unchanged line\nnew\n");
    fireEvent.click(folder);
    fireEvent.click(folder);
    expect(list).toHaveBeenCalledTimes(2);
  });

  it("coalesces watch invalidations while a Git refresh is in flight", async () => {
    let resolve!: (
      value: Awaited<ReturnType<typeof commands.loadWorktreeChanges>>
    ) => void;
    load.mockReturnValueOnce(
      new Promise((done) => {
        resolve = done;
      })
    );
    render(<WorktreeChanges worktreePath="/worktree" />);
    const calls = vi.mocked(useWorktreeWatch).mock.calls;
    const refresh = calls[calls.length - 1][1];
    act(() => refresh());
    act(() => refresh());
    expect(load).toHaveBeenCalledTimes(1);
    await act(async () => resolve({ status: "ok", data: empty }));
    await waitFor(() => expect(load).toHaveBeenCalledTimes(2));
    await screen.findByText("No changes against this baseline.");
  });

  it("refreshes changes and loaded folders on watch signals while retaining document snapshots", async () => {
    await openChangedFile();
    fireEvent.click(screen.getByRole("button", { name: "Files" }));
    const tree = screen.getByRole("navigation", { name: "Worktree files" });
    fireEvent.click(await within(tree).findByRole("button", { name: /src/ }));
    await within(tree).findByRole("button", { name: /util\.ts/ });
    const reads = read.mock.calls.length;
    const loads = load.mock.calls.length;
    const lists = list.mock.calls.length;
    disk["src/app.ts"] = text("external edit", "r2");
    const calls = vi.mocked(useWorktreeWatch).mock.calls;
    const refresh = calls[calls.length - 1][1];
    act(() => refresh());
    await waitFor(() => expect(load.mock.calls.length).toBeGreaterThan(loads));
    await waitFor(() => expect(list.mock.calls.length).toBe(lists + 2));
    expect(read).toHaveBeenCalledTimes(reads);
    expect(
      screen.getByRole("textbox", { name: "Edit src/app.ts" })
    ).toHaveValue("unchanged line\nnew\n");
  });

  it("shares one draft between diff and file views and across files", async () => {
    await openChangedFile();
    expect(screen.getByText("diff editor for src/app.ts")).toBeVisible();
    await waitFor(() =>
      expect(screen.getByLabelText("Baseline contents")).toHaveTextContent(
        "unchanged line old"
      )
    );
    expect(readBaseline).toHaveBeenCalledWith(
      "/worktree",
      "src/app.ts",
      "base-sha"
    );
    fireEvent.change(screen.getByRole("textbox", { name: "Edit src/app.ts" }), {
      target: { value: "draft\n" },
    });
    expect(screen.getByText("Unsaved")).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "File" }));
    expect(
      await screen.findByRole("textbox", { name: "Edit src/app.ts" })
    ).toHaveValue("draft\n");
    fireEvent.click(screen.getByRole("button", { name: "Files" }));
    fireEvent.click(await screen.findByRole("button", { name: /README\.md/ }));
    await screen.findByRole("textbox", { name: "Edit README.md" });
    fireEvent.click(screen.getByRole("button", { name: /^app\.ts/ }));
    expect(
      await screen.findByRole("textbox", { name: "Edit src/app.ts" })
    ).toHaveValue("draft\n");
    fireEvent.click(screen.getByRole("button", { name: "Diff" }));
    expect(
      await screen.findByRole("textbox", { name: "Edit src/app.ts" })
    ).toHaveValue("draft\n");
    expect(save).not.toHaveBeenCalled();
  });

  it("saves with Cmd/Ctrl+S against the read revision and refreshes changes", async () => {
    await openChangedFile();
    fireEvent.change(screen.getByRole("textbox", { name: "Edit src/app.ts" }), {
      target: { value: "saved text\n" },
    });
    const loads = load.mock.calls.length;
    fireEvent.keyDown(
      screen.getByRole("textbox", { name: "Edit src/app.ts" }),
      { key: "s", metaKey: true }
    );
    await waitFor(() =>
      expect(save).toHaveBeenCalledExactlyOnceWith(
        "/worktree",
        "src/app.ts",
        "saved text\n",
        "r1"
      )
    );
    await waitFor(() => expect(screen.queryByText("Unsaved")).toBeNull());
    await waitFor(() => expect(load.mock.calls.length).toBeGreaterThan(loads));
    expect(screen.getByRole("button", { name: "Save" })).toBeDisabled();
    fireEvent.change(screen.getByRole("textbox", { name: "Edit src/app.ts" }), {
      target: { value: "second\n" },
    });
    fireEvent.keyDown(
      screen.getByRole("textbox", { name: "Edit src/app.ts" }),
      { key: "S", ctrlKey: true }
    );
    await waitFor(() =>
      expect(save).toHaveBeenLastCalledWith(
        "/worktree",
        "src/app.ts",
        "second\n",
        "saved:saved text\n"
      )
    );
  });

  it("keeps the draft and offers reconciliation on a save conflict", async () => {
    await openChangedFile();
    fireEvent.change(screen.getByRole("textbox", { name: "Edit src/app.ts" }), {
      target: { value: "mine\n" },
    });
    save.mockResolvedValueOnce({
      status: "ok",
      data: { kind: "conflict", current: "agent" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("changed on disk");
    expect(screen.getByText("Unsaved")).toBeVisible();
    expect(screen.getByRole("button", { name: "Save" })).toBeDisabled();
    fireEvent.click(
      within(alert).getByRole("button", { name: "Overwrite with my edits" })
    );
    await waitFor(() =>
      expect(save).toHaveBeenLastCalledWith(
        "/worktree",
        "src/app.ts",
        "mine\n",
        "agent"
      )
    );
    await waitFor(() => expect(screen.queryByRole("alert")).toBeNull());
    expect(screen.queryByText("Unsaved")).toBeNull();
  });

  it("reloads from disk only when the user discards the draft", async () => {
    await openChangedFile();
    fireEvent.change(screen.getByRole("textbox", { name: "Edit src/app.ts" }), {
      target: { value: "mine\n" },
    });
    save.mockResolvedValueOnce({
      status: "ok",
      data: { kind: "conflict", current: null },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("removed or is no longer text");
    expect(
      within(alert).queryByRole("button", { name: "Overwrite with my edits" })
    ).toBeNull();
    disk["src/app.ts"] = text("agent version\n", "r2");
    fireEvent.click(
      within(alert).getByRole("button", { name: "Discard edits and reload" })
    );
    await waitFor(() =>
      expect(
        screen.getByRole("textbox", { name: "Edit src/app.ts" })
      ).toHaveValue("agent version\n")
    );
    expect(screen.queryByText("Unsaved")).toBeNull();
  });

  it("asks to save, discard or cancel when closing a dirty document", async () => {
    await openChangedFile();
    fireEvent.change(screen.getByRole("textbox", { name: "Edit src/app.ts" }), {
      target: { value: "draft\n" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Close src/app.ts" }));
    const dialog = await screen.findByRole("dialog", {
      name: "Unsaved changes",
    });
    expect(dialog).toHaveTextContent("src/app.ts has unsaved changes.");
    fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
    expect(
      screen.getByRole("textbox", { name: "Edit src/app.ts" })
    ).toHaveValue("draft\n");
    fireEvent.click(screen.getByRole("button", { name: "Close src/app.ts" }));
    fireEvent.click(
      within(
        await screen.findByRole("dialog", { name: "Unsaved changes" })
      ).getByRole("button", { name: "Save" })
    );
    await waitFor(() =>
      expect(save).toHaveBeenCalledWith(
        "/worktree",
        "src/app.ts",
        "draft\n",
        "r1"
      )
    );
    await waitFor(() =>
      expect(
        screen.queryByRole("button", { name: "Close src/app.ts" })
      ).toBeNull()
    );
    fireEvent.click(screen.getByRole("button", { name: "Open diff src/app.ts" }));
    fireEvent.change(
      await screen.findByRole("textbox", { name: "Edit src/app.ts" }),
      { target: { value: "throwaway\n" } }
    );
    fireEvent.click(screen.getByRole("button", { name: "Close src/app.ts" }));
    fireEvent.click(
      within(
        await screen.findByRole("dialog", { name: "Unsaved changes" })
      ).getByRole("button", { name: "Discard" })
    );
    expect(
      screen.queryByRole("button", { name: "Close src/app.ts" })
    ).toBeNull();
    expect(save).toHaveBeenCalledTimes(1);
  });

  it("shows deleted files as read-only baseline diffs", async () => {
    load.mockResolvedValue({ status: "ok", data: modified });
    render(<WorktreeChanges worktreePath="/worktree" />);
    fireEvent.click(
      await screen.findByRole("button", { name: "Open diff gone.txt" })
    );
    await screen.findByText("Deleted file");
    expect(screen.getByLabelText("Baseline contents")).toHaveTextContent("bye");
    expect(screen.getByRole("button", { name: "Save" })).toBeDisabled();
    expect(screen.queryByRole("group", { name: "Document view" })).toBeNull();
    expect(save).not.toHaveBeenCalled();
  });

  it("keeps documents as read instead of watching the disk", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    await openChangedFile();
    const loads = load.mock.calls.length;
    disk["src/app.ts"] = text("agent edit\n", "r2");
    await act(() => vi.advanceTimersByTimeAsync(10_000));
    expect(
      screen.getByRole("textbox", { name: "Edit src/app.ts" })
    ).toHaveValue("unchanged line\nnew\n");
    expect(read).toHaveBeenCalledTimes(1);
    expect(load.mock.calls.length).toBe(loads);
  });

  it("keeps a document open on its conflict when saving from the close dialog fails", async () => {
    await openChangedFile();
    save.mockResolvedValueOnce({
      status: "ok",
      data: { kind: "conflict", current: "r2" },
    });
    fireEvent.change(screen.getByRole("textbox", { name: "Edit src/app.ts" }), {
      target: { value: "draft\n" },
    });
    fireEvent.click(screen.getByRole("button", { name: "All changes" }));
    fireEvent.click(screen.getByRole("button", { name: "Close src/app.ts" }));
    fireEvent.click(
      within(
        await screen.findByRole("dialog", { name: "Unsaved changes" })
      ).getByRole("button", { name: "Save" })
    );
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "changed on disk"
    );
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(
      screen.getByRole("textbox", { name: "Edit src/app.ts" })
    ).toHaveValue("draft\n");
  });

  it("ignores Cmd+S while the unsaved-changes dialog is open", async () => {
    await openChangedFile();
    fireEvent.change(screen.getByRole("textbox", { name: "Edit src/app.ts" }), {
      target: { value: "draft\n" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Close src/app.ts" }));
    const dialog = await screen.findByRole("dialog", {
      name: "Unsaved changes",
    });
    fireEvent.keyDown(dialog, { key: "s", metaKey: true });
    expect(save).not.toHaveBeenCalled();
  });

  it("isolates documents per worktree", async () => {
    const view = await openChangedFile();
    fireEvent.change(screen.getByRole("textbox", { name: "Edit src/app.ts" }), {
      target: { value: "draft for worktree\n" },
    });
    view.unmount();
    render(<WorktreeChanges worktreePath="/other" />);
    await screen.findByRole("button", { name: "Open diff src/app.ts" });
    expect(
      screen.queryByRole("button", { name: "Close src/app.ts" })
    ).toBeNull();
    const workspaces = useDocumentStore.getState().workspaces;
    expect(workspaces["/worktree"]?.documents["src/app.ts"]?.draft).toBe(
      "draft for worktree\n"
    );
    expect(workspaces["/other"]?.documents ?? {}).toEqual({});
  });
});

it("resizes with the keyboard and restores the chosen width after collapse", async () => {
  const measure = vi
    .spyOn(HTMLElement.prototype, "getBoundingClientRect")
    .mockReturnValue({
      width: 800,
    } as DOMRect);
  try {
    render(<WorktreeChanges worktreePath="/worktree" />);
    await screen.findByLabelText("No changes");
    const handle = screen.getByRole("separator", {
      name: "Resize files sidebar",
    });
    expect(handle).toHaveAttribute("aria-valuenow", "240");
    fireEvent.keyDown(handle, { key: "ArrowRight" });
    expect(handle).toHaveAttribute("aria-valuenow", "250");
    fireEvent.click(screen.getByRole("button", { name: "Hide files" }));
    expect(screen.queryByRole("separator")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Show files" }));
    expect(screen.getByRole("separator")).toHaveAttribute(
      "aria-valuenow",
      "250"
    );
  } finally {
    measure.mockRestore();
  }
});

it("shows uncapped backend totals and sends independently selected endpoints", async () => {
  vi.mocked(commands.listComparisonChoices).mockResolvedValue({
    status: "ok",
    data: [
      {
        label: "feature-A",
        endpoint: { kind: "ref", value: "refs/heads/feature-A" },
      },
      { label: "Linked B", endpoint: { kind: "worktree", value: "/linked B" } },
    ],
  });
  load.mockResolvedValue({
    status: "ok",
    data: {
      ...empty,
      totals: { additions: 900000, deletions: 7, binary_files: 2 },
    },
  });
  render(<WorktreeChanges worktreePath="/worktree" />);
  await screen.findByText(/900000/);
  const totals = screen.getByLabelText("Comparison totals");
  expect(totals).toHaveTextContent("+900000");
  expect(totals).toHaveTextContent("−7");
  expect(totals).toHaveTextContent("2 binary");
  expect(screen.queryByText("Comparison details")).not.toBeInTheDocument();
  const changes = screen.getByRole("region", { name: "Worktree changes" });
  changes.focus();
  await runChangesCommand(changes, "Choose base");
  const basePicker = screen.getByRole("combobox", { name: "Comparison base" });
  expect(basePicker).toHaveFocus();
  fireEvent.keyDown(basePicker, { key: "f" });
  fireEvent.keyDown(basePicker, { key: "e" });
  expect(screen.getAllByRole("option")).toHaveLength(1);
  fireEvent.keyDown(basePicker, { key: "Enter" });

  await runChangesCommand(basePicker, "Choose compare target");
  const targetPicker = screen.getByRole("combobox", {
    name: "Comparison target",
  });
  expect(targetPicker).toHaveFocus();
  fireEvent.keyDown(targetPicker, { key: "l" });
  expect(screen.getAllByRole("option")).toHaveLength(1);
  fireEvent.keyDown(targetPicker, { key: "Enter" });
  await waitFor(() =>
    expect(load).toHaveBeenLastCalledWith("/worktree", {
      base: { kind: "ref", value: "refs/heads/feature-A" },
      target: { kind: "worktree", value: "/linked B" },
      merge_base: true,
    })
  );
  expect(screen.getByRole("button", { name: "Files" })).toBeDisabled();
});

it("keeps a local draft while committed targets open read-only with pinned baselines", async () => {
  load.mockImplementation(async (_path, request) => ({
    status: "ok",
    data: {
      ...modified,
      comparison: {
        ...modified.comparison,
        working_tree: request.target.kind === "working_tree",
      },
    },
  }));
  render(<WorktreeChanges worktreePath="/worktree" />);
  await screen.findByLabelText("Diff for src/app.ts");
  fireEvent.click(screen.getByRole("button", { name: "Open diff src/app.ts" }));
  fireEvent.change(
    await screen.findByRole("textbox", { name: "Edit src/app.ts" }),
    { target: { value: "draft" } }
  );
  selectComparison(
    screen.getByRole("combobox", { name: "Comparison target" }),
    "head"
  );
  await screen.findByLabelText("Diff for src/app.ts");
  fireEvent.click(screen.getByRole("button", { name: "Open diff src/app.ts" }));
  await screen.findByLabelText("Historical document src/app.ts");
  const changes = screen.getByRole("region", { name: "Worktree changes" });
  changes.focus();
  await runChangesCommand(changes, "Open full file");
  await screen.findByText("file editor for src/app.ts");
  await runChangesCommand(changes, "Open full diff");
  await screen.findByText("diff editor for src/app.ts");
  expect(
    screen.queryByRole("button", { name: "Save" })
  ).not.toBeInTheDocument();
  expect(readBaseline).toHaveBeenCalledWith(
    "/worktree",
    "src/app.ts",
    "head-sha"
  );
  selectComparison(
    screen.getByRole("combobox", { name: "Comparison target" }),
    "working"
  );
  expect(
    await screen.findByRole("textbox", { name: "Edit src/app.ts" })
  ).toHaveValue("draft");
});

it("offers only Base and Compare and switches diff layout without reloading Git or losing drafts", async () => {
  load.mockResolvedValue({ status: "ok", data: modified });
  render(<WorktreeChanges worktreePath="/worktree" />);
  await screen.findByLabelText("Diff for src/app.ts");
  expect(screen.getAllByRole("combobox")).toHaveLength(2);
  const split = screen.getByRole("button", { name: "Split" });
  fireEvent.click(split);
  expect(split).toHaveAttribute("aria-pressed", "true");
  expect(screen.getByTestId("all-diffs")).toHaveAttribute(
    "data-layout",
    "split"
  );
  fireEvent.click(screen.getByRole("button", { name: "Open diff src/app.ts" }));
  const editor = await screen.findByRole("textbox", {
    name: "Edit src/app.ts",
  });
  fireEvent.change(editor, {
    target: { value: "draft through layout changes" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Unified" }));
  expect(screen.getByTestId("document-editor")).toHaveAttribute(
    "data-layout",
    "unified"
  );
  expect(screen.getByRole("textbox", { name: "Edit src/app.ts" })).toBe(editor);
  expect(editor).toHaveValue("draft through layout changes");
  expect(screen.getByText("Unsaved")).toBeVisible();
  expect(load).toHaveBeenCalledTimes(1);
  expect(
    within(
      screen.getByRole("navigation", { name: "Changed files" })
    ).queryByRole("button", { name: /^Open/ })
  ).toBeNull();
});

describe("WorktreeChanges source references", () => {
  const editor = () => screen.findByTestId("document-editor");
  const active = () =>
    useDocumentStore.getState().workspaces["/worktree"]?.active ?? null;

  it("opens a reference in full-file mode when the working-copy load fails", async () => {
    load.mockResolvedValue({
      status: "error",
      error: { message: "git failed" },
    } as never);
    render(
      <WorktreeChanges
        worktreePath="/worktree"
        sourceJump={{ path: "src/app.ts", line: 2, nonce: 1 }}
      />
    );
    expect(await screen.findByText("file editor for src/app.ts")).toBeVisible();
    expect(await editor()).toHaveAttribute("data-reveal", "2-2");
    // The failure stays visible in All Changes.
    fireEvent.click(screen.getByRole("button", { name: "All changes" }));
    expect(screen.getByRole("alert")).toHaveTextContent("git failed");
  });

  it("waits for the working copy instead of routing on a failed past-commit load", async () => {
    let finish!: (value: Awaited<ReturnType<typeof load>>) => void;
    load.mockImplementation(async (_path, request) =>
      request.target.kind === "working_tree"
        ? { status: "ok", data: modified }
        : ({ status: "error", error: { message: "no commit" } } as never)
    );
    const view = render(<WorktreeChanges worktreePath="/worktree" />);
    await screen.findByLabelText("Diff for src/app.ts");
    selectComparison(
      screen.getByRole("combobox", { name: "Comparison target" }),
      "head"
    );
    expect(await screen.findByText("no commit")).toBeVisible();

    load.mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        })
    );
    view.rerender(
      <WorktreeChanges
        worktreePath="/worktree"
        sourceJump={{ path: "src/app.ts", line: 1, nonce: 1 }}
      />
    );
    await waitFor(() =>
      expect(load).toHaveBeenLastCalledWith(
        "/worktree",
        expect.objectContaining({ target: { kind: "working_tree" } })
      )
    );
    await act(async () => {});
    // The past-commit error does not route the changed line to a file.
    expect(active()).toBeNull();
    expect(screen.queryByTestId("document-editor")).toBeNull();

    await act(async () => finish({ status: "ok", data: modified }));
    expect(
      await screen.findByRole("status", { name: "Jump target" })
    ).toHaveTextContent("src/app.ts");
    expect(active()).toBeNull();
  });

  it("scrolls a revealed range once and drops it on the first edit", async () => {
    load.mockResolvedValue({ status: "ok", data: modified });
    render(
      <WorktreeChanges
        worktreePath="/worktree"
        sourceJump={{ path: "src/util.ts", line: 1, nonce: 1 }}
      />
    );
    const document = await editor();
    expect(document).toHaveAttribute("data-reveal", "1-1");
    expect(document).toHaveAttribute("data-scrolled", "false");
    expect(active()).toBe("src/util.ts");
    expect(screen.getByRole("button", { name: "Show files" })).toHaveAttribute(
      "aria-expanded",
      "false"
    );

    fireEvent.click(screen.getByRole("button", { name: "Finish reveal" }));
    // Still selected, but a remount (save, view change) no longer scrolls.
    expect(await editor()).toHaveAttribute("data-scrolled", "true");
    expect(screen.queryByRole("button", { name: "Finish reveal" })).toBeNull();

    fireEvent.change(
      screen.getByRole("textbox", { name: "Edit src/util.ts" }),
      { target: { value: "edited" } }
    );
    await waitFor(async () =>
      expect(await editor()).toHaveAttribute("data-reveal", "")
    );
  });
});

describe("Changes keyboard focus", () => {
  it("resumes the line cursor when Changes is entered", async () => {
    load.mockResolvedValue({ status: "ok", data: modified });
    const onExit = vi.fn();
    render(<WorktreeChanges worktreePath="/worktree" onExit={onExit} />);
    await screen.findByRole("button", { name: "Jump to src/app.ts" });
    const cursor = screen.getByRole("group", { name: "Code diff selection" });

    act(() => screen.getByRole("region", { name: "Worktree changes" }).focus());
    expect(cursor).toHaveFocus();
    expect(
      screen.queryByRole("contentinfo", { name: "Changes keyboard shortcuts" })
    ).toBeNull();

    fireEvent.keyDown(cursor, { key: "Escape" });
    expect(onExit).toHaveBeenCalledTimes(1);
  });

  it("puts the cursor on collapsed lines and back on code", async () => {
    load.mockResolvedValue({ status: "ok", data: modified });
    render(<WorktreeChanges worktreePath="/worktree" />);
    const cursor = await screen.findByRole("group", { name: "Code diff selection" });
    act(() => cursor.focus());

    fireEvent.keyDown(cursor, { key: "ArrowDown" });
    expect(cursor).toHaveAttribute("data-line-cursor", "gap");

    fireEvent.keyDown(cursor, { key: "ArrowDown" });
    expect(cursor).toHaveAttribute("data-line-cursor", "");
  });

  it("reads both sides of a change for revealing unchanged lines", async () => {
    load.mockResolvedValue({ status: "ok", data: modified });
    const text = (contents: string) => ({
      status: "ok" as const,
      data: { kind: "text" as const, contents, revision: "r" },
    });
    readBaseline.mockResolvedValue(text("old\n"));
    read.mockResolvedValue(text("new\n"));
    render(<WorktreeChanges worktreePath="/worktree" />);
    fireEvent.click(await screen.findByRole("button", { name: "Load contents" }));
    expect(
      await screen.findByRole("status", { name: "Loaded contents" })
    ).toHaveTextContent("new");
    expect(readBaseline).toHaveBeenCalledWith(
      "/worktree",
      "src/app.ts",
      modified.comparison.base_commit
    );
    expect(read).toHaveBeenCalledWith("/worktree", "src/app.ts");
  });
});

describe("Changes palette and viewed files", () => {
  afterEach(() => useCommandPaletteStore.getState().closePalette());

  it("opens the palette's Changes scope: / leads with files, ⌘K with commands", async () => {
    load.mockResolvedValue({ status: "ok", data: modified });
    render(<WorktreeChanges worktreePath="/worktree" />);
    const row = await screen.findByRole("button", { name: "Jump to src/app.ts" });

    expect(fireEvent.keyDown(row, { key: "/" })).toBe(false);
    let palette = useCommandPaletteStore.getState();
    expect(palette.scope).toBe("changes");
    expect(palette.contextItems[0].label).toBe("src/app.ts");
    palette.closePalette();

    fireEvent.keyDown(row, { key: "k", metaKey: true });
    palette = useCommandPaletteStore.getState();
    expect(palette.contextItems[0].label).toBe("Choose base");
    expect(palette.contextItems.map((item) => item.label)).toContain("gone.txt");
  });

  it("lists every discussion action with its keys", async () => {
    load.mockResolvedValue({ status: "ok", data: modified });
    const thread = (id: string, startLine: number, kind = "inline") => ({
      id,
      status: { kind },
      anchor: { path: "src/app.ts", startLine, endLine: startLine, side: "new" },
    });
    const discussion = {
      threads: [
        thread("open", 1),
        thread("closed", 2),
        thread("detached", 3, "detached"),
      ],
      activeId: "open",
      collapsed: new Set<string>(),
      reopen: vi.fn(),
      toggleCollapsed: vi.fn(),
      attach: vi.fn(),
      select: vi.fn(),
    } as unknown as DiscussionValue;
    render(
      <SelectionDiscussionContext.Provider value={discussion}>
        <WorktreeChanges worktreePath="/worktree" />
      </SelectionDiscussionContext.Provider>
    );
    const row = await screen.findByRole("button", { name: "Jump to src/app.ts" });

    fireEvent.keyDown(row, { key: "k", metaKey: true });
    const items = useCommandPaletteStore.getState().contextItems;
    const listed = (label: string) =>
      items
        .filter((item) => item.label === label)
        .map(({ hint, detail }) => [hint, detail]);
    const collapse = shortcutText(DISCUSSION_COLLAPSE_SHORTCUT);
    expect(listed("Show only the latest response")).toEqual([
      ["src/app.ts:1 (new)", collapse],
    ]);
    expect(listed("Ask follow-up")).toEqual([
      ["src/app.ts:1 (new)", shortcutText(DISCUSSION_ASK_SHORTCUT)],
    ]);
    expect(listed("Send selection to main chat")).toEqual([
      ["src/app.ts:1 (new)", shortcutText(DISCUSSION_SEND_SHORTCUT)],
    ]);
    expect(listed("Highlight selected code")).toEqual([
      ["src/app.ts:1 (new)", undefined],
    ]);
    expect(listed("Stop response")).toEqual([]);
    expect(listed("Close discussion")).toEqual([["src/app.ts:1 (new)", "Esc"]]);
    expect(listed("Open discussion")).toEqual([
      ["src/app.ts:2 (new)", "o"],
      ["src/app.ts:3 (new)", undefined],
    ]);

    const run = (label: string) =>
      items.find((item) => item.label === label)!.run();
    run("Open discussion");
    expect(discussion.reopen).toHaveBeenCalledWith("closed", { focus: true });
    run("Ask follow-up");
    expect(discussion.reopen).toHaveBeenCalledWith("open", { focus: true });
    run("Send selection to main chat");
    expect(discussion.attach).toHaveBeenCalledWith(
      discussion.threads[0].anchor,
      false
    );
    run("Highlight selected code");
    expect(discussion.select).toHaveBeenCalledWith(discussion.threads[0].anchor);
    run("Show only the latest response");
    expect(discussion.toggleCollapsed).toHaveBeenCalledWith("open");
  });

  it("marks the active file viewed with v and counts viewed files", async () => {
    load.mockResolvedValue({ status: "ok", data: modified });
    render(<WorktreeChanges worktreePath="/worktree" />);
    const row = await screen.findByRole("button", { name: "Jump to src/app.ts" });
    act(() => row.focus());

    fireEvent.keyDown(row, { key: "v" });
    expect(screen.getByLabelText("Comparison totals")).toHaveTextContent(
      "1/2 viewed"
    );
    fireEvent.keyDown(row, { key: "v" });
    expect(screen.getByLabelText("Comparison totals")).not.toHaveTextContent(
      "viewed"
    );
  });

  it("unmarks the last viewed file with ⇧V, also from the diff", async () => {
    load.mockResolvedValue({ status: "ok", data: modified });
    render(<WorktreeChanges worktreePath="/worktree" />);
    const row = await screen.findByRole("button", { name: "Jump to src/app.ts" });
    act(() => row.focus());
    fireEvent.keyDown(row, { key: "v" });
    expect(screen.getByLabelText("Comparison totals")).toHaveTextContent(
      "1/2 viewed"
    );

    const cursor = screen.getByRole("group", { name: "Code diff selection" });
    expect(fireEvent.keyDown(cursor, { key: "V", shiftKey: true })).toBe(false);
    expect(screen.getByLabelText("Comparison totals")).not.toHaveTextContent(
      "viewed"
    );
    expect(screen.getByRole("status", { name: "Jump target" })).toHaveTextContent(
      "src/app.ts"
    );
  });

  it("lists every viewed file to unmark, and all of them, in the palette", async () => {
    load.mockResolvedValue({ status: "ok", data: modified });
    render(<WorktreeChanges worktreePath="/worktree" />);
    const app = await screen.findByRole("button", { name: "Jump to src/app.ts" });
    act(() => app.focus());
    fireEvent.keyDown(app, { key: "v" });
    const gone = screen.getByRole("button", { name: "Jump to gone.txt" });
    act(() => gone.focus());
    fireEvent.keyDown(gone, { key: "v" });

    fireEvent.keyDown(gone, { key: "k", metaKey: true });
    const items = useCommandPaletteStore.getState().contextItems;
    const unmark = items.filter((item) => item.label === "Unmark file viewed");
    expect(unmark.map((item) => item.hint)).toEqual(["gone.txt", "src/app.ts"]);
    expect(items.map((item) => item.label)).not.toContain("Mark file viewed");

    act(() => items.find((item) => item.label === "Unmark all viewed files")!.run());
    expect(screen.getByLabelText("Comparison totals")).not.toHaveTextContent(
      "viewed"
    );
  });
});

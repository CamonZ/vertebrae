import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WorktreeChanges } from "./WorktreeChanges";
import { useWorktreeWatch } from "./workspace/useWorktreeWatch";
import {
  commands,
  type FileBody,
  type WorktreeChanges as Changes,
} from "../../bindings";
import { useDocumentStore } from "./workspace/documentStore";
import type { AllChangesViewProps } from "./workspace/AllChangesView";
import type { DocumentEditorProps } from "./workspace/DocumentEditor";

vi.mock("./workspace/useWorktreeWatch", () => ({
  useWorktreeWatch: vi.fn(() => null),
}));

vi.mock("../../bindings", () => ({
  commands: {
    loadWorktreeChanges: vi.fn(),
    listWorktreeDirectory: vi.fn(),
    readWorktreeFile: vi.fn(),
    readWorktreeBaselineFile: vi.fn(),
    saveWorktreeFile: vi.fn(),
  },
}));
// Pierre stand-ins: the editor captures its contents at mount like the real one.
vi.mock("./workspace/AllChangesView", () => ({
  default: ({ files, jumpTarget, onOpen }: AllChangesViewProps) => (
    <div>
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
  ),
}));
vi.mock("./workspace/DocumentEditor", () => ({
  default: ({
    path,
    view,
    contents,
    baseline,
    onChange,
  }: DocumentEditorProps) => (
    <div>
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
      patch:
        "diff --git a/src/app.ts b/src/app.ts\n--- a/src/app.ts\n+++ b/src/app.ts\n@@ -1 +1 @@\n-old\n+new\n",
    },
    {
      path: "gone.txt",
      old_path: null,
      status: "deleted",
      marker: null,
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
    await screen.findByRole("button", { name: "Open src/app.ts" })
  );
  await screen.findByRole("textbox", { name: "Edit src/app.ts" });
  return view;
}

describe("WorktreeChanges", () => {
  it("loads on open and refresh and requests the labeled branch baseline", async () => {
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
    expect(load).toHaveBeenCalledExactlyOnceWith("/worktree", false);
    fireEvent.click(screen.getByRole("button", { name: "Refresh changes" }));
    await waitFor(() => expect(load).toHaveBeenCalledTimes(2));
    await screen.findByText("No changes against this baseline.");
    fireEvent.change(screen.getByLabelText("Changes baseline"), {
      target: { value: "branch" },
    });
    await waitFor(() =>
      expect(load).toHaveBeenLastCalledWith("/worktree", true)
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
            patch:
              "diff --git a/old b/new\n--- a/old\n+++ b/new\n@@ -1 +1 @@\n-before\n+after\n",
          },
          {
            path: "binary",
            old_path: null,
            status: "added",
            marker: "binary",
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

  it("keeps failures inline and hides unavailable branch baselines", async () => {
    load.mockResolvedValueOnce({
      status: "error",
      error: { message: "git timed out" },
    });
    render(<WorktreeChanges worktreePath="/missing" />);
    expect(await screen.findByRole("alert")).toHaveTextContent("git timed out");
    load.mockResolvedValueOnce({
      status: "ok",
      data: { ...empty, base_branch: null, base_unavailable: "No base branch" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Refresh changes" }));
    await screen.findByText("No base branch");
    expect(screen.getAllByRole("option")).toHaveLength(1);
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
    expect(load).toHaveBeenLastCalledWith("/new", false);
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
    expect(readBaseline).toHaveBeenCalledWith("/worktree", "src/app.ts", false);
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
    fireEvent.click(screen.getByRole("button", { name: "Open src/app.ts" }));
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
      await screen.findByRole("button", { name: "Open gone.txt" })
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
    await screen.findByRole("button", { name: "Open src/app.ts" });
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

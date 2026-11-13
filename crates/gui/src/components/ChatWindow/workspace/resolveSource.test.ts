import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  commands,
  type FileBody,
  type WorktreeChange,
} from "../../../bindings";
import { resolveSource, shortRevision } from "./resolveSource";

vi.mock("../../../bindings", () => ({
  commands: {
    loadWorktreeChanges: vi.fn(),
    readWorktreeFile: vi.fn(),
    readWorktreeBaselineFile: vi.fn(),
  },
}));
const mocked = vi.mocked(commands);

const text = (contents: string): FileBody => ({
  kind: "text",
  contents,
  revision: "r",
});
const ok = <T>(data: T) => ({ status: "ok" as const, data });

function changes(files: Partial<WorktreeChange>[], baseBranch: string | null) {
  mocked.loadWorktreeChanges.mockResolvedValue(
    ok({
      base_branch: baseBranch,
      base_unavailable: null,
      comparison: {
        base_commit: "0123456789abcdef0123",
        selected_base_commit: "0123456789abcdef0123",
        target_commit: "head",
        working_tree: true,
        merge_base: true,
      },
      totals: { additions: 0, deletions: 0, binary_files: 0 },
      files: files.map((file) => ({
        path: "a.ts",
        old_path: null,
        status: "modified",
        patch: "",
        totals: { additions: 0, deletions: 0, binary_files: 0 },
        marker: null,
        ...file,
      })),
    })
  );
}

/** Contents by `path@revision`; `path` alone is the working copy. */
function files(byKey: Record<string, FileBody>) {
  const read = (key: string) => ok(byKey[key] ?? { kind: "missing" });
  mocked.readWorktreeFile.mockImplementation(async (_root, path) => read(path));
  mocked.readWorktreeBaselineFile.mockImplementation(
    async (_root, path, commit) => read(`${path}@${commit}`)
  );
}

beforeEach(() => vi.resetAllMocks());

describe("resolveSource", () => {
  it("abbreviates object ids but keeps names", () => {
    expect(shortRevision("0123456789abcdef0123")).toBe("01234567");
    expect(shortRevision("main")).toBe("main");
  });

  it("shows an unchanged working file, even when changes cannot load", async () => {
    mocked.loadWorktreeChanges.mockRejectedValue(new Error("not a repo"));
    files({ "a.ts": text("one") });
    expect(await resolveSource("/c", { path: "a.ts" })).toEqual({
      kind: "file",
      path: "a.ts",
      contents: "one",
    });
  });

  it("diffs a renamed file found by its old path against the base branch", async () => {
    changes(
      [{ path: "b.ts", old_path: "a.ts", status: "renamed" }],
      "refs/remotes/origin/main"
    );
    files({ "a.ts@0123456789abcdef0123": text("old"), "b.ts": text("new") });
    expect(await resolveSource("/c", { path: "a.ts" })).toEqual({
      kind: "diff",
      path: "b.ts",
      oldPath: "a.ts",
      status: "renamed",
      before: "old",
      after: "new",
      label: "origin/main → the working tree",
    });
  });

  it("diffs a deleted file without reading the working copy", async () => {
    changes([{ status: "deleted" }], null);
    files({ "a.ts@0123456789abcdef0123": text("gone") });
    const source = await resolveSource("/c", { path: "a.ts" });
    expect(source).toMatchObject({
      kind: "diff",
      status: "deleted",
      before: "gone",
      after: null,
      label: "01234567 → the working tree",
    });
    expect(mocked.readWorktreeFile).not.toHaveBeenCalled();
  });

  it("compares a base with the working copy when head is absent", async () => {
    files({ "a.ts@v1": text("old"), "a.ts": text("new") });
    expect(await resolveSource("/c", { path: "a.ts", base: "v1" })).toEqual(
      expect.objectContaining({
        kind: "diff",
        status: "modified",
        label: "v1 → the working tree",
      })
    );
    expect(mocked.loadWorktreeChanges).not.toHaveBeenCalled();
  });

  it("notes a range that leaves the file unchanged", async () => {
    files({ "a.ts@v1": text("same"), "a.ts@v2": text("same") });
    expect(
      await resolveSource("/c", { path: "a.ts", base: "v1", head: "v2" })
    ).toEqual({
      kind: "file",
      path: "a.ts",
      contents: "same",
      note: "a.ts is unchanged between v1 and v2.",
    });
  });

  it("explains contents that cannot be shown", async () => {
    files({ "a.ts@v1": { kind: "binary" }, "a.ts@v2": text("x") });
    expect(
      await resolveSource("/c", { path: "a.ts", base: "v1", head: "v2" })
    ).toEqual({
      kind: "unavailable",
      message: "a.ts is binary at v1 and cannot be shown.",
    });
  });

  it("rejects with the command error", async () => {
    mocked.readWorktreeBaselineFile.mockResolvedValue({
      status: "error",
      error: { message: "unknown revision" },
    });
    mocked.readWorktreeFile.mockResolvedValue(ok(text("x")));
    await expect(
      resolveSource("/c", { path: "a.ts", base: "nope" })
    ).rejects.toThrow("unknown revision");
  });
});

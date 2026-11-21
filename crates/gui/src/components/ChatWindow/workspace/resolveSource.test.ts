import { beforeEach, describe, expect, it, vi } from "vitest";
import { commands, type FileBody } from "../../../bindings";
import { resolveSource, shortRevision } from "./resolveSource";

vi.mock("../../../bindings", () => ({
  commands: {
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

  it("reads one pinned file without comparing it or reading the working copy", async () => {
    const commit = "1".repeat(40);
    files({ "a.ts": text("working"), [`a.ts@${commit}`]: text("pinned") });
    expect(
      await resolveSource("/c", "a.ts", { kind: "commit", commit })
    ).toEqual({
      kind: "file",
      path: "a.ts",
      contents: "pinned",
    });
    expect(mocked.readWorktreeBaselineFile).toHaveBeenCalledExactlyOnceWith(
      "/c",
      "a.ts",
      commit
    );
    expect(mocked.readWorktreeFile).not.toHaveBeenCalled();
  });

  it("compares a base with the working copy when head is absent", async () => {
    files({ "a.ts@v1": text("old"), "a.ts": text("new") });
    expect(
      await resolveSource("/c", "a.ts", { kind: "range", base: "v1" })
    ).toEqual(
      expect.objectContaining({
        kind: "diff",
        status: "modified",
        label: "v1 → the working tree",
      })
    );
  });

  it("notes a range that leaves the file unchanged", async () => {
    files({ "a.ts@v1": text("same"), "a.ts@v2": text("same") });
    expect(
      await resolveSource("/c", "a.ts", {
        kind: "range",
        base: "v1",
        head: "v2",
      })
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
      await resolveSource("/c", "a.ts", {
        kind: "range",
        base: "v1",
        head: "v2",
      })
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
      resolveSource("/c", "a.ts", { kind: "range", base: "nope" })
    ).rejects.toThrow("unknown revision");
  });
});

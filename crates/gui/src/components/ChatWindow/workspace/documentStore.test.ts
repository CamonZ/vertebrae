import { beforeEach, describe, expect, it, vi } from "vitest";
import { commands, type FileBody } from "../../../bindings";
import {
  closeDocument,
  documentOf,
  loadDocument,
  openDocument,
  overwriteDocument,
  saveDocument,
  saveDocuments,
  setDraft,
  useDocumentStore,
} from "./documentStore";

vi.mock("../../../bindings", () => ({
  commands: {
    readWorktreeFile: vi.fn(),
    saveWorktreeFile: vi.fn(),
  },
}));
const read = vi.mocked(commands.readWorktreeFile);
const save = vi.mocked(commands.saveWorktreeFile);

type ReadResult = Awaited<ReturnType<typeof read>>;
type SaveResult = Awaited<ReturnType<typeof save>>;
const text = (contents: string, revision: string): ReadResult => ({
  status: "ok",
  data: { kind: "text", contents, revision } satisfies FileBody,
});

function deferred() {
  let resolve!: (value: ReadResult) => void;
  const promise = new Promise<ReadResult>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

beforeEach(() => {
  useDocumentStore.setState({ workspaces: {} });
  read.mockReset();
  save.mockReset();
});

describe("documentStore", () => {
  it("isolates worktrees and drops results for closed documents", async () => {
    const first = deferred();
    read
      .mockReturnValueOnce(first.promise)
      .mockResolvedValueOnce(text("b", "rb"));
    openDocument("/a", "same.txt", "file");
    openDocument("/b", "same.txt", "file");
    await vi.waitFor(() =>
      expect(documentOf("/b", "same.txt")?.disk).toEqual({
        kind: "text",
        contents: "b",
        revision: "rb",
      })
    );
    closeDocument("/a", "same.txt");
    first.resolve(text("late", "ra"));
    await first.promise;
    expect(documentOf("/a", "same.txt")).toBeUndefined();
    expect(documentOf("/b", "same.txt")?.disk).toMatchObject({ contents: "b" });
  });

  it("keeps only the newest read", async () => {
    const older = deferred();
    read.mockResolvedValueOnce(text("v1", "r1"));
    openDocument("/w", "f", "file");
    await vi.waitFor(() =>
      expect(documentOf("/w", "f")?.disk.kind).toBe("text")
    );
    read
      .mockReturnValueOnce(older.promise)
      .mockResolvedValueOnce(text("v3", "r3"));
    const stale = loadDocument("/w", "f");
    await loadDocument("/w", "f");
    older.resolve(text("v2", "r2"));
    await stale;
    expect(documentOf("/w", "f")?.disk).toMatchObject({ revision: "r3" });
  });

  it("drops a closed document's read after the same path reopens", async () => {
    const closed = deferred();
    read
      .mockReturnValueOnce(closed.promise)
      .mockResolvedValueOnce(text("current", "r2"));
    openDocument("/w", "f", "file");
    closeDocument("/w", "f");
    openDocument("/w", "f", "file");
    await vi.waitFor(() =>
      expect(documentOf("/w", "f")?.disk).toMatchObject({ revision: "r2" })
    );
    closed.resolve(text("stale", "r1"));
    await closed.promise;
    expect(documentOf("/w", "f")?.disk).toMatchObject({ revision: "r2" });
  });

  it("does not let a read started before a save restore older contents", async () => {
    await openText("v1", "r1");
    const older = deferred();
    read.mockReturnValueOnce(older.promise);
    const stale = loadDocument("/w", "f");
    setDraft("/w", "f", "mine");
    save.mockResolvedValueOnce(saved("r2"));
    expect(await saveDocument("/w", "f")).toBe(true);
    older.resolve(text("v1", "r1"));
    await stale;
    expect(documentOf("/w", "f")?.disk).toEqual({
      kind: "text",
      contents: "mine",
      revision: "r2",
    });
  });

  it("saves against the read revision and clears the draft", async () => {
    await openText("v1", "r1");
    setDraft("/w", "f", "v2");
    save.mockResolvedValueOnce(saved("r2"));
    expect(await saveDocument("/w", "f")).toBe(true);
    expect(save).toHaveBeenCalledWith("/w", "f", "v2", "r1");
    const document = documentOf("/w", "f");
    expect(document?.draft).toBeNull();
    expect(document?.disk).toMatchObject({ contents: "v2", revision: "r2" });
  });

  it("keeps the draft on a conflict and overwrites only on request", async () => {
    await openText("v1", "r1");
    setDraft("/w", "f", "mine");
    save.mockResolvedValueOnce({
      status: "ok",
      data: { kind: "conflict", current: "r9" },
    });
    expect(await saveDocument("/w", "f")).toBe(false);
    expect(documentOf("/w", "f")?.draft).toBe("mine");
    expect(documentOf("/w", "f")?.conflict).toEqual({ revision: "r9" });
    expect(await saveDocument("/w", "f")).toBe(false);
    expect(save).toHaveBeenCalledTimes(1);
    save.mockResolvedValueOnce(saved("r10"));
    expect(await overwriteDocument("/w", "f")).toBe(true);
    expect(save).toHaveBeenLastCalledWith("/w", "f", "mine", "r9");
    expect(documentOf("/w", "f")?.conflict).toBeNull();
  });

  it("never overwrites a file that disappeared", async () => {
    await openText("v1", "r1");
    setDraft("/w", "f", "mine");
    save.mockResolvedValueOnce({
      status: "ok",
      data: { kind: "conflict", current: null },
    });
    expect(await saveDocument("/w", "f")).toBe(false);
    expect(await overwriteDocument("/w", "f")).toBe(false);
    expect(save).toHaveBeenCalledTimes(1);
  });

  it("keeps the draft and reports command errors", async () => {
    await openText("v1", "r1");
    setDraft("/w", "f", "mine");
    save.mockResolvedValueOnce({
      status: "error",
      error: { message: "disk full" },
    });
    expect(await saveDocument("/w", "f")).toBe(false);
    expect(documentOf("/w", "f")?.draft).toBe("mine");
    expect(documentOf("/w", "f")?.saveError).toBe("disk full");
  });

  it("reports which documents a batch save could not write", async () => {
    read
      .mockResolvedValueOnce(text("a", "ra"))
      .mockResolvedValueOnce(text("b", "rb"));
    openDocument("/w", "a", "file");
    openDocument("/w", "b", "file");
    await vi.waitFor(() =>
      expect(documentOf("/w", "b")?.disk.kind).toBe("text")
    );
    setDraft("/w", "a", "a2");
    setDraft("/w", "b", "b2");
    save.mockImplementation(async (_worktree, path) =>
      path === "a"
        ? saved("ra2")
        : { status: "error", error: { message: "denied" } }
    );
    expect(await saveDocuments("/w", ["a", "b"])).toEqual(["b"]);
  });
});

const saved = (revision: string): SaveResult => ({
  status: "ok",
  data: { kind: "saved", revision },
});

async function openText(contents: string, revision: string) {
  read.mockResolvedValueOnce(text(contents, revision));
  openDocument("/w", "f", "file");
  await vi.waitFor(() =>
    expect(documentOf("/w", "f")?.disk).toMatchObject({ revision })
  );
}

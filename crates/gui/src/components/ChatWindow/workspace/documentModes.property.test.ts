import { beforeEach, expect, test, vi } from "vitest";
import * as hegel from "@hegeldev/hegel";
import * as gs from "@hegeldev/hegel/generators";
import { commands } from "../../../bindings";
import {
  currentText,
  documentOf,
  isDirty,
  loadBaseline,
  openDocument,
  setDraft,
  setView,
  useDocumentStore,
} from "./documentStore";

vi.mock("../../../bindings", () => ({
  commands: {
    readWorktreeFile: vi.fn().mockResolvedValue({
      status: "ok",
      data: { kind: "text", contents: "disk", revision: "r1" },
    }),
    readWorktreeBaselineFile: vi.fn(),
  },
}));

beforeEach(() => useDocumentStore.setState({ workspaces: {} }));

test("generated mode switches preserve owned draft contents and dirty state", () =>
  hegel.testAsync(async (tc) => {
    useDocumentStore.setState({ workspaces: {} });
    openDocument("/fixture", "file", "diff");
    await Promise.resolve();
    expect(documentOf("/fixture", "file")?.disk.kind).toBe("text");

    const operations = tc.draw(
      gs.arrays(gs.integers({ minValue: 0, maxValue: 3 }), { maxSize: 40 })
    );
    let contents = "disk";

    for (const operation of operations) {
      if (operation < 2)
        setView("/fixture", "file", operation === 0 ? "file" : "diff");
      else {
        contents = operation === 2 ? "draft" : "disk";
        setDraft("/fixture", "file", contents);
      }

      const document = documentOf("/fixture", "file")!;
      expect(currentText(document)).toBe(contents);
      expect(isDirty(document)).toBe(contents !== "disk");
    }
  }));

test("late baseline reads cannot replace a newer commit", async () => {
  openDocument("/fixture", "file", "diff");
  let resolve!: (
    value: Awaited<ReturnType<typeof commands.readWorktreeBaselineFile>>
  ) => void;
  const old = new Promise<
    Awaited<ReturnType<typeof commands.readWorktreeBaselineFile>>
  >((done) => {
    resolve = done;
  });
  vi.mocked(commands.readWorktreeBaselineFile)
    .mockReturnValueOnce(old)
    .mockResolvedValueOnce({
      status: "ok",
      data: { kind: "text", contents: "new", revision: "new" },
    });
  const pending = loadBaseline(
    "/fixture",
    "file",
    "old-name",
    "old-commit",
    "old-key"
  );
  await loadBaseline("/fixture", "file", "file", "new-commit", "new-key");
  resolve({
    status: "ok",
    data: { kind: "text", contents: "old", revision: "old" },
  });
  await pending;

  expect(documentOf("/fixture", "file")?.baseline?.body).toMatchObject({
    contents: "new",
  });
  expect(commands.readWorktreeBaselineFile).toHaveBeenLastCalledWith(
    "/fixture",
    "file",
    "new-commit"
  );
});

import { beforeEach, expect, it, vi } from "vitest";
import { commands } from "../../../bindings";
import { resolveTurnSource } from "./resolveTurnSource";

vi.mock("../../../bindings", () => ({
  commands: { readChatHistoryFile: vi.fn(), readWorktreeFile: vi.fn() },
}));
const history = { sessionId: "chat", turnId: "old" };
beforeEach(() => vi.resetAllMocks());

it("uses recorded contents after the current file was deleted, and never substitutes main", async () => {
  vi.mocked(commands.readChatHistoryFile).mockResolvedValue({
    status: "ok",
    data: { kind: "text", contents: "old contents", revision: "old" },
  });
  vi.mocked(commands.readWorktreeFile).mockResolvedValue({
    status: "ok",
    data: { kind: "missing" },
  });

  expect(
    await resolveTurnSource("/feature", "a.ts", history, false)
  ).toMatchObject({ kind: "file", contents: "old contents" });
  expect(commands.readWorktreeFile).not.toHaveBeenCalled();
  expect(
    await resolveTurnSource("/feature", "a.ts", history, true)
  ).toMatchObject({
    kind: "unavailable",
    message: expect.stringContaining("no longer exists"),
  });
  expect(commands.readWorktreeFile).toHaveBeenCalledExactlyOnceWith(
    "/feature",
    "a.ts"
  );
});

it("requires an explicit latest action when legacy history is missing", async () => {
  expect(
    await resolveTurnSource(
      "/feature",
      "a.ts",
      { sessionId: "chat", turnId: null },
      false
    )
  ).toMatchObject({ kind: "unavailable" });
  expect(commands.readChatHistoryFile).not.toHaveBeenCalled();
  expect(commands.readWorktreeFile).not.toHaveBeenCalled();
});

it("reports capture errors instead of opening current contents", async () => {
  vi.mocked(commands.readChatHistoryFile).mockResolvedValue({
    status: "error",
    error: { message: "Snapshot exceeded its limit" },
  });
  expect(await resolveTurnSource("/feature", "a.ts", history, false)).toEqual({
    kind: "unavailable",
    message: "Snapshot exceeded its limit",
    retryable: true,
  });
  expect(commands.readWorktreeFile).not.toHaveBeenCalled();
});

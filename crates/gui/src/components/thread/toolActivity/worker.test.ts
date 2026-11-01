import { afterEach, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  init: vi.fn(),
  load: vi.fn(),
  analyze: vi.fn(),
}));
vi.mock("web-tree-sitter", () => ({
  Parser: { init: mocks.init },
  Language: { load: mocks.load },
}));
vi.mock("./parser", () => ({ analyzeActivity: mocks.analyze }));
afterEach(() => {
  vi.unstubAllGlobals();
  vi.resetModules();
  vi.resetAllMocks();
});

it("links grammars serially before servicing queued calls in the shared WASM runtime", async () => {
  mocks.init.mockResolvedValue(undefined);
  const finish: Array<(value: object) => void> = [];
  mocks.load.mockImplementation(
    () => new Promise((resolve) => finish.push(resolve))
  );
  mocks.analyze.mockReturnValue({
    operations: [
      {
        source: "git status",
        activities: ["Git inspection"],
        relationships: [],
      },
    ],
  });
  const scope = {
    onmessage: undefined as undefined | ((event: unknown) => void),
    postMessage: vi.fn(),
  };
  vi.stubGlobal("self", scope);
  await import("./worker");
  scope.onmessage?.({
    data: { id: 1, call: { name: "Bash", input: { command: "git status" } } },
  });
  await vi.waitFor(() => expect(finish).toHaveLength(1));
  expect(scope.postMessage).not.toHaveBeenCalled();
  finish[0]({ language: "javascript" });
  await vi.waitFor(() => expect(finish).toHaveLength(2));
  expect(mocks.analyze).not.toHaveBeenCalled();
  finish[1]({ language: "bash" });
  await vi.waitFor(() => expect(finish).toHaveLength(3));
  finish[2]({ language: "python" });
  await vi.waitFor(() => expect(scope.postMessage).toHaveBeenCalledOnce());
  expect(mocks.analyze.mock.calls[0][1]).toEqual({
    javascript: { language: "javascript" },
    bash: { language: "bash" },
    python: { language: "python" },
  });
});

it("returns an initialization diagnostic without losing the queued request identity", async () => {
  mocks.init.mockResolvedValue(undefined);
  mocks.load.mockRejectedValue(new Error("unresolved scanner export"));
  const scope = {
    onmessage: undefined as undefined | ((event: unknown) => void),
    postMessage: vi.fn(),
  };
  vi.stubGlobal("self", scope);
  await import("./worker");
  scope.onmessage?.({
    data: { id: 42, call: { name: "Bash", input: { command: "git status" } } },
  });
  await vi.waitFor(() => expect(scope.postMessage).toHaveBeenCalledOnce());
  expect(scope.postMessage.mock.calls[0][0]).toMatchObject({
    id: 42,
    kind: "error",
    error: {
      phase: "initialization",
      retryable: true,
      message: "Parser initialization failed: unresolved scanner export",
    },
  });
  expect(mocks.analyze).not.toHaveBeenCalled();
});

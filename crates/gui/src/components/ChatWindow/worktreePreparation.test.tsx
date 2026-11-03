import { act, render, screen, waitFor } from "@testing-library/react";
import { useEffect } from "react";
import { afterEach, expect, it, vi } from "vitest";
import { WorktreeChanges } from "./WorktreeChanges";
import type { AllChangesViewProps } from "./workspace/AllChangesView";
import { preparePatches } from "../thread/toolChange/preparePatches";
import type { BackgroundOutputs, BackgroundTask } from "../../background/types";

const state = vi.hoisted(() => ({
  load: vi.fn(),
  refresh: () => {},
  mounts: 0,
  jobs: [] as Array<{
    task: Extract<BackgroundTask, { kind: "patch" }>;
    signal: AbortSignal;
    resolve(value: BackgroundOutputs["patch"]): void;
  }>,
}));

vi.mock("../../bindings", () => ({
  commands: {
    loadWorktreeChanges: state.load,
    listWorktreeDirectory: vi.fn(async () => ({
      status: "ok",
      data: { entries: [], truncated: false },
    })),
  },
}));

vi.mock("../../background/client", () => ({
  backgroundClient: {
    run: (
      task: Extract<BackgroundTask, { kind: "patch" }>,
      signal: AbortSignal
    ) =>
      new Promise<BackgroundOutputs["patch"]>((resolve) =>
        state.jobs.push({ task, signal, resolve })
      ),
  },
}));

vi.mock("../thread/toolChange/useWorktreeDelta", () => ({
  preloadDiffRenderer: () => {},
}));

vi.mock("./workspace/useWorktreeWatch", () => ({
  useWorktreeWatch: (_path: string, refresh: () => void) => {
    state.refresh = refresh;
    return null;
  },
}));

vi.mock("./workspace/AllChangesView", () => ({
  default: function View({ files, parsedPatches }: AllChangesViewProps) {
    useEffect(() => {
      state.mounts++;
    }, []);

    return (
      <div data-testid="diff-view">
        {files[0].path}:{parsedPatches[0].reviewFiles[0].newPath}
      </div>
    );
  },
}));

const file = (path: string) => ({
  path,
  old_path: null,
  status: "modified",
  marker: null,
  patch: `diff --git a/${path} b/${path}\n--- a/${path}\n+++ b/${path}\n@@ -1 +1 @@\n-a\n+b\n`,
});
const loaded = (path: string) => ({
  status: "ok",
  data: { files: [file(path)], base_branch: "master", base_unavailable: null },
});
const finish = async (index: number) => {
  await act(async () =>
    state.jobs[index].resolve(preparePatches(state.jobs[index].task))
  );
};

afterEach(() => {
  state.jobs.length = 0;
  state.load.mockReset();
  state.mounts = 0;
  vi.unstubAllGlobals();
});

it("publishes parsed metadata atomically and keeps the diff viewport mounted during refresh", async () => {
  vi.stubGlobal("Worker", class {});
  state.load
    .mockResolvedValueOnce(loaded("a.ts"))
    .mockResolvedValueOnce(loaded("b.ts"));

  render(<WorktreeChanges worktreePath="/worktree" />);
  await waitFor(() => expect(state.jobs).toHaveLength(1));
  await finish(0);
  expect(await screen.findByTestId("diff-view")).toHaveTextContent("a.ts:a.ts");
  const viewport = screen.getByTestId("diff-view");

  act(() => state.refresh());
  await waitFor(() => expect(state.jobs).toHaveLength(2));
  expect(screen.getByTestId("diff-view")).toBe(viewport);
  expect(viewport).toHaveTextContent("a.ts:a.ts");

  await finish(1);
  expect(screen.getByTestId("diff-view")).toBe(viewport);
  expect(viewport).toHaveTextContent("b.ts:b.ts");
  expect(state.mounts).toBe(1);
});

it("aborts worker preparation on worktree replacement and rejects its late result", async () => {
  vi.stubGlobal("Worker", class {});
  state.load
    .mockResolvedValueOnce(loaded("old.ts"))
    .mockResolvedValueOnce(loaded("new.ts"));

  const view = render(<WorktreeChanges worktreePath="/old" />);
  await waitFor(() => expect(state.jobs).toHaveLength(1));

  view.rerender(<WorktreeChanges worktreePath="/new" />);
  await waitFor(() => expect(state.jobs).toHaveLength(2));
  expect(state.jobs[0].signal.aborted).toBe(true);

  await finish(0);
  expect(screen.queryByTestId("diff-view")).toBeNull();

  await finish(1);
  expect(await screen.findByTestId("diff-view")).toHaveTextContent(
    "new.ts:new.ts"
  );
});

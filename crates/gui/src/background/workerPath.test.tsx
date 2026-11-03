import { renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { InProcessWorker } from "./inProcessWorker.test.helpers";
import { useBackgroundTask } from "./useBackgroundTask";
import type { BackgroundTask } from "./types";
import { buildToolChain } from "../components/thread/toolChange/diffComments";
import { filePatch } from "../components/thread/toolChange/diffPatchBuilder.test.helpers";
import type { ToolAnnotations } from "../stores/toolAnnotations";

const prepareToolChain = (
  task: Extract<BackgroundTask, { kind: "tool_chain" }>
) => buildToolChain(task.annotations);

beforeEach(() => {
  InProcessWorker.reset();
  vi.stubGlobal("Worker", InProcessWorker);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

it("prepares the review tool chain on the worker with the inline result", async () => {
  const annotations: ToolAnnotations = {
    edit: {
      worktree_delta: {
        session_id: "s",
        tool_id: "edit",
        kind: "worktree_delta",
        recorded_at: "2026-11-03T12:00:00Z",
        payload: {
          patch: filePatch({ path: "f", before: ["a"], after: ["b"] }),
          files: [{ path: "f", status: "modified" }],
        },
      },
    },
  };
  const task: Extract<BackgroundTask, { kind: "tool_chain" }> = {
    kind: "tool_chain",
    annotations,
  };
  const { result } = renderHook(() =>
    useBackgroundTask(task, prepareToolChain)
  );

  expect(result.current.pending).toBe(true);
  await waitFor(() => expect(result.current.pending).toBe(false));
  expect(result.current.error).toBeUndefined();
  expect(result.current.value).toEqual(buildToolChain(annotations));
  expect(result.current.value).toHaveLength(1);
  expect(InProcessWorker.instances.at(-1)?.requests).toEqual(["tool_chain"]);
});

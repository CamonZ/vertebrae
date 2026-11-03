import { expect, it } from "vitest";
import { executeBackgroundTask } from "./execute";
import { preparePatches } from "../components/thread/toolChange/preparePatches";
import { prepareProviderReplay } from "../stores/prepareProviderReplay";
import type { BackgroundTask } from "./types";

const timestamp = "2026-11-03T12:00:00Z";
const patch =
  "diff --git a/a.ts b/a.ts\n--- a/a.ts\n+++ b/a.ts\n@@ -1 +1 @@\n-old\n+new\n";

it("preserves canonical renderer metadata and review line mapping across structured cloning", async () => {
  const task: Extract<BackgroundTask, { kind: "patch" }> = {
    kind: "patch",
    patches: [patch],
    review: true,
  };

  const output = structuredClone(
    await executeBackgroundTask(structuredClone(task))
  );

  expect(output).toEqual({ kind: "patch", value: preparePatches(task) });
});

it("replays and reconciles interleaved snapshots using the same canonical projection", async () => {
  const lines = ["a", "b"].map((item, index) =>
    JSON.stringify({
      version: 1,
      event_id: item,
      stream_id: "stream",
      sequence: index,
      timestamp,
      correlation: { turn_id: "turn", item_id: item },
      semantics: "snapshot",
      type: "text",
      data: { text: `final ${item}`, completion_status: "completed" },
    })
  );

  const task: Extract<BackgroundTask, { kind: "replay" }> = {
    kind: "replay",
    input: {
      kind: "initial",
      refresh: false,
      lines,
      context: { id: "session", providerResumeId: null },
      previousInstalled: [],
      messages: [
        {
          kind: "assistant",
          itemId: "a",
          turnId: "turn",
          text: "partial",
          timestamp,
          isPartial: true,
          lifecycle: "streaming",
        },
      ],
    },
  };

  const response = structuredClone(
    await executeBackgroundTask(structuredClone(task))
  );

  expect(response).toEqual({
    kind: "replay",
    value: prepareProviderReplay(task.input),
  });

  if (response.kind !== "replay") throw new Error("Unexpected response");
  expect(response.value.messages).toMatchObject([
    { text: "final a" },
    { text: "final b" },
  ]);
});

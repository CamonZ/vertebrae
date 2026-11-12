import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { Thread } from "./Thread";
import {
  ThreadFindContext,
  messageMatches,
  normalizeFindQuery,
  threadMatches,
} from "./find";
import type { Thread as ThreadModel, ToolMessage } from "./types";

const tool: ToolMessage = {
  evt: "tool-1",
  type: "tool",
  cmd: "rg",
  kind: "shell",
  body: "needle in the recorded output",
  collapsed: true,
};

function runThread(): ThreadModel {
  return {
    id: "exec-1",
    step: { to: "implement", kind: "llm" },
    turns: [
      {
        id: "t0",
        messages: [
          {
            evt: "a1",
            type: "agent",
            speaker: "Agent",
            prose: "Decomposing the work.",
          },
          {
            type: "spawn",
            evt: "spawn-1",
            thread: {
              id: "sub-1",
              label: "write_failing_test",
              kind: "llm",
              spawnLabel: "subagent",
              turns: [
                {
                  id: "st0",
                  messages: [
                    {
                      evt: "sa1",
                      type: "agent",
                      speaker: "Subagent",
                      prose: "found the haystack",
                    },
                  ],
                },
              ],
            },
          },
        ],
      },
    ],
  };
}

function renderThread(query: string, thread = runThread()) {
  return render(
    <ThreadFindContext.Provider value={normalizeFindQuery(query)}>
      <Thread thread={thread} depth={0} mode="bare" reveal="deep" readOnly />
    </ThreadFindContext.Provider>
  );
}

describe("thread find", () => {
  it("matches message model fields, including collapsed tool output", () => {
    expect(messageMatches(tool, "needle")).toBe(true);
    expect(messageMatches(tool, "rg")).toBe(true);
    expect(messageMatches(tool, "absent")).toBe(false);
    expect(messageMatches(tool, "")).toBe(false);
  });

  it("matches nested subagent messages through the thread tree", () => {
    expect(threadMatches(runThread(), "haystack")).toBe(true);
    expect(threadMatches(runThread(), "implement")).toBe(true);
    expect(threadMatches(runThread(), "nothing")).toBe(false);
  });

  it("leaves subagents collapsed without a query", () => {
    renderThread("");
    expect(screen.queryByText("found the haystack")).toBeNull();
  });

  it("opens a collapsed subagent containing a match and marks the row", () => {
    const { container } = renderThread("HAYSTACK");

    expect(screen.getByText("found the haystack")).toBeInTheDocument();
    const marked = container.querySelectorAll("[data-find-match]");
    expect(marked).toHaveLength(1);
    expect(marked[0]).toHaveTextContent("found the haystack");
  });

  it("marks step heads and subagent summaries whose labels match", () => {
    const { container } = renderThread("write_failing");
    expect(container.querySelector(".sth-sum[data-find-match]")).not.toBeNull();
  });
});

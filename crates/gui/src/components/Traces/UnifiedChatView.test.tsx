import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { UnifiedChatView } from "./UnifiedChatView";
import type { Thread } from "../thread/types";

function run(): Thread[] {
  return [
    {
      id: "th-1",
      step: { to: "accept_user_turn", kind: "execute", at: "01:13:42" },
      summary: { turns: 1, tools: 1, status: "ok" },
      turns: [
        {
          id: "t0",
          messages: [
            {
              evt: "a1",
              type: "agent",
              at: "01:13:54",
              speaker: "Agent",
              prose: "Decomposing the work.",
            },
            { evt: "t1", type: "tool", at: "01:14:01", cmd: "rg", kind: "shell" },
          ],
        },
      ],
    },
  ];
}

function runWithSub(): Thread[] {
  return [
    {
      id: "th-1",
      step: { to: "verify_changes", kind: "execute", at: "01:22:40" },
      summary: { turns: 1, tools: 1, status: "ok" },
      turns: [
        {
          id: "t0",
          messages: [
            {
              type: "spawn",
              evt: "spawn-1",
              thread: {
                id: "sub-1",
                label: "write_failing_test",
                kind: "execute",
                spawnLabel: "subagent",
                summary: { turns: 1, tools: 0, status: "ok" },
                turns: [
                  {
                    id: "st0",
                    messages: [
                      {
                        evt: "sa1",
                        type: "agent",
                        speaker: "Subagent",
                        prose: "done",
                      },
                    ],
                  },
                ],
              },
            },
          ],
        },
      ],
    },
  ];
}

describe("UnifiedChatView (single-run threads)", () => {
  it("renders an empty state with no threads", () => {
    render(<UnifiedChatView threads={[]} />);
    expect(screen.getByTestId("unified-chat-empty")).toBeInTheDocument();
  });

  it("renders an error state", () => {
    render(<UnifiedChatView threads={[]} error="boom" />);
    expect(screen.getByTestId("unified-chat-error").textContent).toContain(
      "boom"
    );
  });

  it("renders a loading state when loading with no threads", () => {
    render(<UnifiedChatView threads={[]} isLoading />);
    expect(screen.getByTestId("unified-chat-loading")).toBeInTheDocument();
  });

  it("renders the run's threads via the primitive (step head + prose)", () => {
    render(<UnifiedChatView threads={run()} />);
    expect(screen.getByTestId("unified-chat-view")).toBeInTheDocument();
    expect(screen.getByText("accept_user_turn")).toBeInTheDocument();
    expect(screen.getByText("Decomposing the work.")).toBeInTheDocument();
  });

  it("tags root thread rows with data-thread-id for scroll targeting", () => {
    const { container } = render(<UnifiedChatView threads={run()} />);
    expect(container.querySelector('[data-thread-id="th-1"]')).not.toBeNull();
  });

  it("renders only the focused subthread when focused is set", () => {
    const subThread = runWithSub()[0].turns[0].messages[0];
    if (subThread.type !== "spawn") throw new Error("expected spawn");
    render(<UnifiedChatView threads={runWithSub()} focused={subThread.thread} />);
    expect(screen.getByText("done")).toBeInTheDocument();
    expect(screen.queryByText("verify_changes")).toBeNull();
  });

  it("renders the human-input gate when provided", () => {
    render(
      <UnifiedChatView
        threads={[]}
        humanInputGate={{
          run: { id: "run-1" } as never,
          execution: null,
          stepName: "wait_children",
          prompt: null,
          outputSchema: null,
        }}
      />
    );
    expect(screen.getByTestId("human-input-gate")).toBeInTheDocument();
  });

  it("reflects autoScroll in a data attribute", () => {
    render(<UnifiedChatView threads={run()} autoScroll />);
    expect(
      screen.getByTestId("unified-chat-view").getAttribute("data-auto-scroll")
    ).toBe("1");
  });

  it("invokes onSelect when a step head is clicked", () => {
    const onSelect = vi.fn();
    render(<UnifiedChatView threads={run()} onSelect={onSelect} />);
    fireEvent.click(screen.getByText("accept_user_turn"));
    expect(onSelect).toHaveBeenCalledWith("th-1");
  });
});

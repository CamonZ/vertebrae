import { describe, it, expect, vi } from "vitest";
import { createRef } from "react";
import { render, screen, fireEvent } from "@testing-library/react";
import { FlightStrip } from "./FlightStrip";
import { buildFlightProjection } from "./timeline";
import type { Thread } from "../thread/types";

function flatRun(): Thread[] {
  return [
    {
      id: "th-1",
      step: { to: "accept_user_turn", kind: "execute", at: "01:13:42" },
      summary: { turns: 1, tools: 2, status: "ok" },
      turns: [
        {
          id: "t0",
          messages: [
            {
              evt: "a1",
              type: "agent",
              at: "01:13:54",
              speaker: "Agent",
              prose: "hi",
            },
            { evt: "t1", type: "tool", at: "01:14:01", cmd: "rg", kind: "shell" },
            {
              evt: "t2",
              type: "tool",
              at: "01:14:02",
              cmd: "mix test",
              kind: "shell",
              error: true,
              status: "err",
            },
          ],
        },
      ],
    },
    {
      id: "th-2",
      step: { to: "wait_for_children", kind: "wait", at: "01:50:14" },
      summary: { turns: 1, tools: 0, status: "waiting" },
      turns: [
        {
          id: "wt0",
          messages: [
            { evt: "w1", type: "wait", at: "01:50:15", text: "waiting" },
          ],
        },
      ],
    },
  ];
}

function runWithSubagent(): Thread[] {
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
              evt: "t1",
              type: "tool",
              at: "01:22:48",
              cmd: "mix test",
              kind: "shell",
            },
            {
              type: "spawn",
              evt: "spawn-1",
              thread: {
                id: "sub-1",
                label: "write_failing_test",
                kind: "execute",
                spawnLabel: "subagent",
                summary: { turns: 1, tools: 1, status: "ok" },
                turns: [
                  {
                    id: "st0",
                    messages: [
                      {
                        evt: "st1",
                        type: "tool",
                        at: "01:23:09",
                        cmd: "mix test",
                        kind: "shell",
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

describe("buildFlightProjection", () => {
  it("produces one step segment per root thread", () => {
    const p = buildFlightProjection(flatRun());
    expect(p.steps.map((s) => s.threadId)).toEqual(["th-1", "th-2"]);
    expect(p.steps[1].kind).toBe("wait");
    expect(p.steps[1].live).toBe(true);
  });

  it("emits a tool pip per tool (error flagged) and a turn pip per agent", () => {
    const p = buildFlightProjection(flatRun());
    expect(p.tools.map((t) => t.evt)).toContain("t1");
    expect(p.tools.find((t) => t.evt === "t2")?.error).toBe(true);
    expect(p.turns.map((t) => t.evt)).toEqual(["a1"]);
  });

  it("has no subagents for a flat run", () => {
    const p = buildFlightProjection(flatRun());
    expect(p.hasSpawns).toBe(false);
    expect(p.spawns).toHaveLength(0);
  });

  it("projects a subagent segment + edge when a spawn is present", () => {
    const p = buildFlightProjection(runWithSubagent());
    expect(p.hasSpawns).toBe(true);
    expect(p.spawns.map((s) => s.threadId)).toEqual(["sub-1"]);
    expect(p.spawnEdges.map((e) => e.childThreadId)).toEqual(["sub-1"]);
  });
});

describe("FlightStrip", () => {
  it("renders the strip with steps/tools/turns lanes", () => {
    render(<FlightStrip threads={flatRun()} />);
    expect(screen.getByTestId("flight-strip")).toBeInTheDocument();
    expect(screen.getAllByTestId("flight-strip-step")).toHaveLength(2);
    expect(screen.getAllByTestId("flight-strip-tool").length).toBeGreaterThan(0);
    expect(screen.getAllByTestId("flight-strip-turn")).toHaveLength(1);
  });

  it("hides the subagent lane and renders no spawns when empty", () => {
    render(<FlightStrip threads={flatRun()} />);
    expect(screen.queryByTestId("flight-strip-spawn")).toBeNull();
    expect(screen.queryByText("Subagents")).toBeNull();
  });

  it("renders the subagent lane when there are spawns", () => {
    render(<FlightStrip threads={runWithSubagent()} />);
    expect(screen.getByText("Subagents")).toBeInTheDocument();
    expect(screen.getByTestId("flight-strip-spawn")).toBeInTheDocument();
    expect(screen.getByTestId("flight-strip-spawn-edge")).toBeInTheDocument();
  });

  it("selects a step on click", () => {
    const onSelect = vi.fn();
    render(<FlightStrip threads={flatRun()} onSelect={onSelect} />);
    fireEvent.click(screen.getAllByTestId("flight-strip-step")[0]);
    expect(onSelect).toHaveBeenCalledWith("th-1");
  });

  it("marks the selected pip", () => {
    render(<FlightStrip threads={flatRun()} selectedEvt="t1" />);
    const sel = screen
      .getAllByTestId("flight-strip-tool")
      .find((el) => el.getAttribute("data-evt") === "t1");
    expect(sel?.className).toContain("sel");
  });

  it("positions markers by measured scroll offset, not by time", async () => {
    // A fake linked scroll container: 1000px of content, th-1's row laid out
    // halfway down. By *time* th-1 is the earliest step (left ≈ 0); the strip
    // must instead place it at the measured pixel offset (50%).
    const container = document.createElement("div");
    Object.defineProperty(container, "scrollHeight", { value: 1000 });
    Object.defineProperty(container, "clientHeight", { value: 200 });
    container.scrollTop = 0;
    container.getBoundingClientRect = () =>
      ({ top: 0, left: 0, width: 300, height: 200 }) as DOMRect;

    const place = (sel: string, top: number, height: number): void => {
      const node = document.createElement("div");
      const [attr, val] = sel.startsWith("th:")
        ? ["data-thread-id", sel.slice(3)]
        : ["data-evt", sel.slice(3)];
      node.setAttribute(attr, val);
      node.getBoundingClientRect = () =>
        ({ top, left: 0, width: 300, height }) as DOMRect;
      container.appendChild(node);
    };
    place("th:th-1", 500, 200);
    place("th:th-2", 800, 100);
    place("ev:a1", 510, 20);
    place("ev:t1", 540, 20);
    place("ev:t2", 560, 20);

    const ref = createRef<HTMLDivElement>();
    ref.current = container;

    render(<FlightStrip threads={flatRun()} threadScrollRef={ref} />);

    const step1 = screen
      .getAllByTestId("flight-strip-step")
      .find((el) => el.getAttribute("data-thread-id") === "th-1")!;
    await vi.waitFor(() => {
      expect(step1.style.left).toBe("50%");
    });
    expect(step1.style.width).toBe("20%");

    const a1 = screen
      .getAllByTestId("flight-strip-turn")
      .find((el) => el.getAttribute("data-evt") === "a1")!;
    expect(a1.style.left).toBe("51%");
  });
});

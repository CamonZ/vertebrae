import { readFileSync } from "node:fs";
import {
  fireEvent,
  render,
  screen,
  act,
  waitFor,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ToolActivityGroup } from "./ToolActivityGroup";
import { TurnLiveContext } from "./TurnLiveContext";
import { activityLabel, groupToolMessages } from "./grouping";
import { ChatSessionContext } from "../toolChange/ChatSessionContext";
import type { ToolMessage } from "../types";
import {
  commands,
  type ActivityAnalysis as ParsedActivity,
} from "../../../bindings";

vi.mock("../../../bindings", () => ({
  commands: { analyzeToolActivities: vi.fn(), classifyToolOperations: vi.fn() },
}));

const analyze = vi.mocked(commands.analyzeToolActivities);
const classify = vi.mocked(commands.classifyToolOperations);
beforeEach(() => {
  analyze.mockReset();
  classify.mockReset();
  analyze.mockImplementation(async (calls) => ({
    status: "ok",
    data: calls.map(({ name }) => ({
      operations: [{ source: name, activities: [], relationships: [] }],
    })),
  }));
});

const call = (
  evt: string,
  status: ToolMessage["status"] = "pending"
): ToolMessage => ({
  type: "tool",
  evt,
  toolId: evt,
  name: "exec",
  status,
  activityInput: { name: "exec", input: { code: "cargo test" } },
  rawInput: '  {"code":"cargo test"} ',
  recordedResult: status === "pending" ? undefined : "exact\nrecorded result",
});
describe("activity disclosure", () => {
  it("counts outer calls and separates groups at every intervening message", () => {
    const a = call("a"),
      b = call("b");
    const groups = groupToolMessages([
      a,
      b,
      { type: "agent", evt: "prose", prose: "checking" },
      call("c"),
    ]);
    expect(groups).toHaveLength(3);
    expect(groups[0]).toEqual([a, b]);
  });
  it("deduplicates activities and limits the compact union with overflow", () => {
    const row = {
      operations: ["edits", "checks", "Git", "docs", "search", "edits"].map(
        (activity) => ({
          activities: [activity],
          source: "x",
          relationships: [],
        })
      ),
    };
    expect(activityLabel([row, row])).toBe("edits, checks, Git, docs +1 more");
  });
  it("uses the reported tool summary as the call label", async () => {
    render(
      <ToolActivityGroup calls={[{ ...call("pwd", "done"), activityInput: { name: "CommandLine", input: {} }, reportedSummary: "Print working directory" }]} />
    );
    fireEvent.click(screen.getByRole("button", { name: /1 call for/ }));
    const row = await screen.findByRole("button", { name: /Print working directory.*CommandLine.*Raw arguments/ });
    expect(row).toHaveTextContent("Print working directory");
    expect(row).toHaveTextContent("CommandLine");
    expect(screen.queryByText("Unclassified")).toBeNull();
  });

  it("shows the description and command in a collapsed single-call group", () => {
    render(<ToolActivityGroup calls={[{
      ...call("pwd", "done"),
      reportedSummary: "Print working directory",
      activityInput: { name: "run_command", input: { CommandLine: "pwd" } },
    }]} />);
    const group = screen.getByRole("button", { name: /Print working directory.*CommandLine: pwd/ });
    expect(group).toHaveAttribute("aria-expanded", "false");
    fireEvent.click(group);
    expect(screen.getByRole("button", { name: /Print working directory.*CommandLine: pwd.*Raw arguments/ })).toBeVisible();
  });

  it("shows Claude's Bash description and command in both disclosures", () => {
    render(
      <ToolActivityGroup calls={[{
        ...call("claude", "done"),
        reportedSummary: "Print working directory",
        activityInput: { name: "Bash", input: { command: "pwd" } },
      }]} />
    );
    const group = screen.getByRole("button", { name: /Print working directory.*Bash: pwd/ });
    expect(group).toHaveAttribute("aria-expanded", "false");
    fireEvent.click(group);
    expect(screen.getByRole("button", { name: /Print working directory.*Bash: pwd.*Raw arguments/ })).toBeVisible();
  });

  it("supports keyboard disclosure and lazily mounts raw content", async () => {
    const user = userEvent.setup();
    const Raw = vi.fn(() => <div>expensive content</div>);
    const { rerender } = render(
      <ToolActivityGroup calls={[{ ...call("a"), body: <Raw /> }]} />
    );
    const group = screen.getByRole("button", { name: /1 call for/ });
    expect(Raw).not.toHaveBeenCalled();
    group.focus();
    await user.keyboard("{Enter}");
    expect(group).toHaveAttribute("aria-expanded", "true");
    expect(Raw).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: /Raw arguments/ }));
    expect(Raw).toHaveBeenCalledOnce();
    expect(screen.getByText("expensive content")).toBeInTheDocument();
    rerender(<ToolActivityGroup calls={[call("a", "err"), call("b")]} />);
    expect(screen.getByRole("button", { name: /2 calls for/ })).toHaveAttribute(
      "aria-expanded",
      "true"
    );
    expect(
      screen.getByText("exact recorded result", { exact: false })
    ).toBeInTheDocument();
    expect(screen.getByText("Recorded error")).toBeInTheDocument();
    expect(screen.getAllByText("exec").length).toBeGreaterThan(0);
    expect(
      screen.getByText('{"code":"cargo test"}', { exact: false }).textContent
    ).toBe('  {"code":"cargo test"} ');
    // Settle fallback enrichment before leaving the test.
    await act(async () => {});
  });
});

it("retains raw choices across group toggles and resets them across sessions", () => {
  const content = (session: string) => (
    <ChatSessionContext.Provider value={session}>
      <ToolActivityGroup calls={[call("same-id", "done")]} />
    </ChatSessionContext.Provider>
  );
  const { rerender } = render(content("a"));
  const group = screen.getByRole("button", { name: /1 call for/ });
  fireEvent.click(group);
  fireEvent.click(screen.getByRole("button", { name: /Raw arguments/ }));
  fireEvent.click(group);
  expect(screen.queryByText(/exact recorded result/)).not.toBeInTheDocument();
  fireEvent.click(group);
  expect(screen.getByRole("button", { name: /Raw arguments/ })).toHaveAttribute(
    "aria-expanded",
    "true"
  );
  rerender(content("b"));
  expect(screen.getByRole("button", { name: /1 call for/ })).toHaveAttribute(
    "aria-expanded",
    "false"
  );
});

it("labels raw input and result panels and connects their disclosure control", () => {
  render(<ToolActivityGroup calls={[call("a", "done")]} />);
  fireEvent.click(screen.getByRole("button", { name: /1 call for/ }));
  const toggle = screen.getByRole("button", {
    name: /Raw arguments and recorded result/,
  });
  fireEvent.click(toggle);
  expect(
    document.getElementById(toggle.getAttribute("aria-controls")!)
  ).toBeInTheDocument();
  expect(screen.getByRole("region", { name: "Arguments" })).toBeInTheDocument();
  expect(
    screen.getByRole("region", { name: "Recorded result" })
  ).toBeInTheDocument();
  expect(screen.getByLabelText("Raw recorded result")).toHaveAttribute(
    "tabindex",
    "0"
  );
});

it("keeps overflow in its own visible badge beside the truncating activity label", async () => {
  analyze.mockResolvedValue({
    status: "ok",
    data: [
      {
        operations: ["one", "two", "three", "four", "five"].map((activity) => ({
          activities: [activity],
          source: activity,
          relationships: [],
        })),
      },
    ],
  });
  const ui = render(<ToolActivityGroup calls={[call("overflow", "done")]} />);
  try {
    await waitFor(() =>
      expect(screen.getByText("+1 more")).toBeInTheDocument()
    );
    expect(
      screen.getByRole("button", {
        name: /1 call for one, two, three, four.*\+1 more/,
      })
    ).toBeInTheDocument();
  } finally {
    ui.unmount();
  }
});

it("keeps routine completion and operation diagnostics out of the first expansion", async () => {
  render(<ToolActivityGroup calls={[call("quiet", "done")]} />);
  fireEvent.click(screen.getByRole("button", { name: /1 call for/ }));
  expect(screen.queryByText("Result recorded")).not.toBeInTheDocument();
  expect(screen.queryByLabelText("Raw arguments")).not.toBeInTheDocument();
  expect(document.querySelector(".tool-activity-operations")).toBeNull();
  expect(document.querySelectorAll(".tool-activity-call-toggle")).toHaveLength(
    1
  );
  fireEvent.click(screen.getByRole("button", { name: /Raw arguments/ }));
  expect(document.querySelector(".tool-activity-operations")).toBeNull();
  expect(document.querySelectorAll(".tool-activity-call-toggle")).toHaveLength(
    1
  );
  expect(screen.getByLabelText("Raw arguments").textContent).toBe(
    '  {"code":"cargo test"} '
  );
  await act(async () => {});
});

it("shows only one semantic disclosure row per Bash call before raw expansion", async () => {
  const sources = [
    "npm run build",
    "scripts/validate.sh gui",
    "python3 -c 'p.write_text(1); unknown()'",
  ];
  let finish!: (result: Awaited<ReturnType<typeof classify>>) => void;
  classify.mockReturnValueOnce(
    new Promise((resolve) => {
      finish = resolve;
    })
  );
  // These rows were captured from the WASM parser and also asserted by the Rust parity test.
  const recorded: {
    call: { name: string; input: { command?: string } };
    expected: ParsedActivity;
  }[] = readFileSync(
    "../syntax/tests/fixtures/review-compatibility.jsonl",
    "utf8"
  )
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  const baselineRows = sources.map((source) => {
    const row = recorded.find(
      ({ call }) => call.name === "Bash" && call.input.command === source
    );
    if (!row) throw new Error(`Missing reference row for ${source}`);
    return row.expected;
  });
  analyze.mockResolvedValue({ status: "ok", data: baselineRows });
  const calls = sources.map((command, i) => ({
    ...call(String(i), "done"),
    name: "Bash",
    activityInput: { name: "Bash", input: { command } },
  }));
  const ui = render(
    <ChatSessionContext.Provider value="fixture-session">
      <ToolActivityGroup calls={calls} />
    </ChatSessionContext.Provider>
  );
  try {
    fireEvent.click(screen.getByRole("button", { name: /3 calls for/ }));
    const build = await screen.findByRole("button", {
      name: /^Build — Raw arguments/,
    });
    expect(
      screen.getByRole("button", { name: /^Validation — Raw arguments/ })
    ).toBeInTheDocument();
    expect(
      await screen.findByRole("button", { name: /^Edit files — Raw arguments/ })
    ).toBeInTheDocument();
    expect(classify).toHaveBeenCalledWith(
      [sources[2]],
      null,
      "fixture-session"
    );
    await act(async () => finish({ status: "ok", data: [["checks"]] }));
    expect(
      await screen.findByRole("button", {
        name: /^Edit files · Validation — Raw arguments/,
      })
    ).toBeInTheDocument();
    expect(screen.queryByText("Bash")).not.toBeInTheDocument();
    expect(screen.queryByText("p.write_text")).not.toBeInTheDocument();
    for (const row of ui.container.querySelectorAll(".tool-activity-call")) {
      expect(row.children).toHaveLength(1);
      expect(row.firstElementChild?.tagName).toBe("BUTTON");
    }
    expect(
      screen.queryByLabelText("Raw recorded result")
    ).not.toBeInTheDocument();
    fireEvent.click(build);
    expect(screen.getByText("Bash")).toBeInTheDocument();
    expect(screen.getByLabelText("Raw recorded result")).toBeInTheDocument();
  } finally {
    ui.unmount();
  }
});

it("shows the unavailable state and retries the group after a command error", async () => {
  analyze.mockResolvedValueOnce({
    status: "error",
    error: { message: "Activity analysis failed." },
  });
  render(<ToolActivityGroup calls={[call("retry", "done")]} />);
  fireEvent.click(screen.getByRole("button", { name: /1 call for/ }));
  const retry = await screen.findByRole("button", { name: "Retry analysis" });
  expect(
    screen.getByRole("button", { name: /Analysis unavailable.*Raw arguments/ })
  ).toBeInTheDocument();
  fireEvent.click(retry);
  await waitFor(() =>
    expect(
      screen.queryByRole("button", { name: "Retry analysis" })
    ).not.toBeInTheDocument()
  );
  expect(analyze).toHaveBeenCalledTimes(2);
});

describe("turn liveness", () => {
  it("shows awaiting results only while the turn is live", async () => {
    const { rerender } = render(<ToolActivityGroup calls={[call("a")]} />);
    expect(screen.getByText("1 awaiting results")).toBeInTheDocument();
    rerender(
      <TurnLiveContext.Provider value={false}>
        <ToolActivityGroup calls={[call("a")]} />
      </TurnLiveContext.Provider>
    );
    expect(screen.queryByText(/awaiting results/)).not.toBeInTheDocument();
    await act(async () => {});
  });
});

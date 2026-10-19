import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type {
  GateDraft,
  GateField,
  LocalChatGateBinding,
} from "../../bindings";
import {
  useChatStore,
  type ChatMessage,
  type ChatSession,
} from "../../stores/chatStore";
import { useUIStore } from "../../stores/uiStore";
import type { GateChatStatus } from "../../utils/gateChat";
import { DEFAULT_GATE_STEERING_THRESHOLDS } from "../../utils/gateDraft";
import { GateDraftProgress } from "./GateDraftProgress";
import { GateSteering } from "./GateSteering";

const sendGateHiddenTurn = vi.hoisted(() => vi.fn().mockResolvedValue(true));
vi.mock("../../hooks/useGateChat", () => ({ sendGateHiddenTurn }));

const setGateDraft = vi.hoisted(() => vi.fn());
vi.mock("../../hooks/useHumanInputDraft", () => ({ setGateDraft }));

const stopRun = vi.hoisted(() =>
  vi.fn().mockResolvedValue({ status: "ok", data: null })
);
vi.mock("../../bindings", () => ({ commands: { stopRun } }));

const FIELDS: GateField[] = [
  {
    name: "approved",
    required: true,
    type: "boolean",
    question: "Should v2 ship?",
    value_type: "boolean",
    choices: null,
    multiple: false,
    format: null,
  },
  {
    name: "reason",
    required: true,
    type: "string",
    question: "Why?",
    value_type: "string",
    choices: null,
    multiple: false,
    format: null,
  },
  {
    name: "notes",
    required: false,
    type: "string",
    question: null,
    value_type: "string",
    choices: null,
    multiple: false,
    format: null,
  },
];

const GATE: LocalChatGateBinding = {
  task_run_id: "run-1",
  step_name: "approve",
  execution_id: "exec-1",
  artifact: "approval",
  draftable: true,
  fields: FIELDS,
};

const DRAFT: GateDraft = {
  execution_id: "exec-1",
  values: { approved: true },
  missing: ["reason"],
  invalid: [],
  complete: false,
  updated_at: "2026-10-19T12:00:00.000Z",
};

const at = (second: number) =>
  new Date(Date.UTC(2026, 9, 19, 12, 0, second)).toISOString();

function status(overrides: Partial<GateChatStatus> = {}): GateChatStatus {
  return {
    phase: "drafting",
    attempt: 1,
    waitingExecutionId: "exec-1",
    waitingSince: at(0),
    draftUpdatedAt: at(0),
    ...overrides,
  };
}

/** `turns` completed user turns after the draft's last change. */
function seedSession(turns: number, overrides: Partial<ChatSession> = {}) {
  const messages: ChatMessage[] = [];
  for (let turn = 1; turn <= turns; turn++) {
    messages.push({
      kind: "user",
      text: `turn ${turn}`,
      timestamp: at(turn * 2),
    });
    messages.push({
      kind: "assistant",
      text: "ok",
      timestamp: at(turn * 2 + 1),
    });
  }
  const session: ChatSession = {
    id: "gate-chat",
    label: "Resolve approve",
    messages,
    status: "open",
    harness: "claude",
    backendSessionId: "backend-1",
    providerResumeId: null,
    lifecycle: "idle",
    gate: GATE,
    ...overrides,
  };
  useChatStore.setState({ sessions: { "gate-chat": session } });
}

function renderSteering(gateStatus = status()) {
  return render(
    <GateSteering
      sessionId="gate-chat"
      gate={GATE}
      status={gateStatus}
      draft={DRAFT}
    />
  );
}

describe("GateSteering", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useUIStore.setState({
      gateSteeringThresholds: DEFAULT_GATE_STEERING_THRESHOLDS,
    });
  });

  it("keeps an offered form and its dirty answer when agent progress resets the stall", async () => {
    seedSession(6);
    const user = userEvent.setup();
    const { rerender } = renderSteering();
    await user.type(screen.getByRole("textbox"), "Still typing");
    rerender(
      <GateSteering
        sessionId="gate-chat"
        gate={GATE}
        status={status({ draftUpdatedAt: at(10) })}
        draft={{
          ...DRAFT,
          values: { approved: true, reason: "Agent answer" },
          complete: true,
          missing: [],
        }}
      />
    );
    expect(screen.getByRole("textbox")).toHaveValue("Still typing");
  });

  it("stays quiet until the soft threshold", () => {
    seedSession(2);
    renderSteering();

    expect(sendGateHiddenTurn).not.toHaveBeenCalled();
    expect(screen.queryByTestId("gate-steering")).not.toBeInTheDocument();
  });

  it("injects one hidden hint naming what is still needed per stall", () => {
    seedSession(3);
    const { rerender } = renderSteering();

    expect(sendGateHiddenTurn).toHaveBeenCalledTimes(1);
    expect(sendGateHiddenTurn).toHaveBeenCalledWith(
      "gate-chat",
      "[Vertebrae steering] Still needed: reason (Why?). Acknowledge what the user said, then steer back to these."
    );
    rerender(
      <GateSteering
        sessionId="gate-chat"
        gate={GATE}
        status={status()}
        draft={DRAFT}
      />
    );
    expect(sendGateHiddenTurn).toHaveBeenCalledTimes(1);
    // The hint is not a visible tier.
    expect(screen.queryByTestId("gate-steering")).not.toBeInTheDocument();
  });

  it("waits for a running turn before counting it or hinting", () => {
    seedSession(3, { lifecycle: "streaming" });
    renderSteering();

    expect(sendGateHiddenTurn).not.toHaveBeenCalled();
  });

  it("resets the count when the draft changes", () => {
    seedSession(7);
    renderSteering(status({ draftUpdatedAt: at(30) }));

    expect(sendGateHiddenTurn).not.toHaveBeenCalled();
    expect(screen.queryByTestId("gate-steering")).not.toBeInTheDocument();
  });

  it("renders the remaining fields as a form and reports its answers", async () => {
    const user = userEvent.setup();
    seedSession(6);
    renderSteering();

    const form = screen.getByTestId("gate-steering-form");
    expect(form).toBeInTheDocument();
    expect(
      screen.queryByTestId("gate-steering-escape")
    ).not.toBeInTheDocument();
    // Only what the draft still needs is asked.
    const fields = screen
      .getAllByTestId("gate-answer-field")
      .map((field) => field.getAttribute("data-field"));
    expect(fields).toEqual(["reason"]);

    await user.type(screen.getByRole("textbox"), "Rollback is ready");
    sendGateHiddenTurn.mockClear();
    await user.click(screen.getByTestId("gate-steering-answer-form-submit"));

    expect(setGateDraft).toHaveBeenCalledWith("exec-1", {
      reason: "Rollback is ready",
    });
    expect(sendGateHiddenTurn).toHaveBeenCalledWith(
      "gate-chat",
      '[Vertebrae form] The user answered: reason: "Rollback is ready".'
    );
  });

  it("offers to keep going or stop the run at the escape threshold", async () => {
    const user = userEvent.setup();
    seedSession(9);
    renderSteering();

    expect(screen.getByTestId("gate-steering")).toHaveAttribute(
      "data-tier",
      "escape"
    );
    await user.click(screen.getByTestId("gate-steering-stop"));
    expect(stopRun).not.toHaveBeenCalled();
    await user.click(screen.getByTestId("gate-steering-stop"));
    expect(stopRun).toHaveBeenCalledWith({
      task_run_id: "run-1",
      task_id: null,
    });

    await user.click(screen.getByTestId("gate-steering-keep-going"));
    expect(screen.queryByTestId("gate-steering")).not.toBeInTheDocument();
    expect(
      useChatStore.getState().sessions["gate-chat"].gateSteering?.resetAt
    ).toEqual(expect.any(Number));
  });

  it("follows the configured thresholds", () => {
    act(() =>
      useUIStore.setState({
        gateSteeringThresholds: { soft: 1, form: 2, escape: 3 },
      })
    );
    seedSession(2);
    renderSteering();

    expect(screen.getByTestId("gate-steering")).toHaveAttribute(
      "data-tier",
      "form"
    );
  });
});

describe("GateDraftProgress", () => {
  it("shows each field's question and whether the draft answers it", () => {
    render(
      <GateDraftProgress
        fields={FIELDS}
        attempt={2}
        draft={{
          ...DRAFT,
          values: { approved: "maybe" },
          invalid: [{ path: "/approved", message: "Type mismatch." }],
        }}
      />
    );

    const rows = screen.getAllByTestId("gate-draft-field");
    expect(rows.map((row) => row.getAttribute("data-state"))).toEqual([
      "invalid",
      "missing",
      "optional",
    ]);
    expect(rows[0]).toHaveTextContent("Should v2 ship?");
    expect(rows[0]).toHaveTextContent("maybe");
    expect(screen.getByTestId("gate-draft-invalid")).toHaveTextContent(
      "Type mismatch."
    );
    expect(rows[1]).toHaveTextContent("not yet answered");
    expect(screen.getByTestId("gate-draft-attempt")).toHaveTextContent(
      "Attempt 2"
    );
  });

  it("marks recorded answers", () => {
    render(<GateDraftProgress fields={FIELDS} attempt={1} draft={DRAFT} />);

    const approved = screen
      .getAllByTestId("gate-draft-field")
      .find((row) => row.getAttribute("data-field") === "approved");
    expect(approved).toHaveAttribute("data-state", "answered");
    expect(approved).toHaveTextContent("Yes");
  });
});

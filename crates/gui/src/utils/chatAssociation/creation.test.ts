import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import type {
  ActivityAnalysis,
  ActivityInput,
} from "../../components/thread/toolActivity/types";
import type { ChatMessage } from "../../stores/chatStore";
import { createdTicketId, creationEvidence, ticketCommand } from "./creation";

const ID = "29bd103a-84d4-4529-b70e-894173e46c1e";
const output = JSON.stringify({
  command: "add",
  status: "created",
  task_id: ID,
});

// The native parser tests verify these same inputs against the recorded analyses.
const fixtures: { call: ActivityInput; expected: ActivityAnalysis }[] =
  readFileSync("../syntax/tests/fixtures/association-syntax.jsonl", "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));

const syntax = async (call: ActivityInput): Promise<ActivityAnalysis> => {
  const fixture = fixtures.find(
    (fixture) => JSON.stringify(fixture.call) === JSON.stringify(call)
  );
  if (!fixture)
    throw new Error(`Missing syntax fixture for ${JSON.stringify(call)}`);
  return fixture.expected;
};

const call = (
  cmd: string,
  toolId = "a"
): Extract<ChatMessage, { kind: "tool_call" }> => ({
  kind: "tool_call",
  toolName: "Bash",
  input: JSON.stringify({ command: cmd }),
  toolId,
  timestamp: "1",
});

const result = (toolId = "a", extra = {}): ChatMessage => ({
  kind: "tool_result",
  result: output,
  isError: false,
  toolId,
  timestamp: "2",
  ...extra,
});

describe("ticket creation evidence", () => {
  it.each([
    'vtb --json add "Ticket" -l ticket',
    'vtb add "Ticket" --level ticket --json',
    'vtb add "Ticket" --level=ticket --json',
    `bash -c 'vtb --json add "Ticket" -l ticket'`,
  ])("recognizes literal shell syntax: %s", async (cmd) => {
    const messages = [call(cmd), result()];

    const evidence = await creationEvidence(messages, syntax);

    expect(evidence.id).toBe(ID);
  });

  it("recognizes one literal execution wrapper", async () => {
    const wrapper: ChatMessage = {
      ...call(""),
      kind: "tool_call",
      toolName: "functions.exec",
      input:
        "text(await tools.exec_command({cmd: 'vtb --json add \"Ticket\" -l ticket'}));",
    };

    const evidence = await creationEvidence(
      [
        wrapper,
        result("a", { result: JSON.stringify({ output, exit_code: 0 }) }),
      ],
      syntax
    );

    expect(evidence.id).toBe(ID);
  });

  it.each([
    "echo 'vtb --json add \"Ticket\" -l ticket'",
    'vtb --json add "Ticket"',
    'vtb --json add "Ticket" -l task',
    'vtb --json add "Ticket" -l epic',
    'vtb add "Ticket" -l ticket',
    'vtb --json add "-l ticket"',
    'vtb --json add "Ticket" -d "-l ticket"',
    'vtb --json add "$TITLE" -l ticket',
    'false && vtb --json add "Ticket" -l ticket',
    'vtb --json add "Ticket" -l ticket | cat',
    'f() { vtb --json add "Ticket" -l ticket; }',
  ])("rejects unsupported or non-creation syntax: %s", async (cmd) => {
    const messages = [call(cmd), result()];

    const evidence = await creationEvidence(messages, syntax);

    expect(evidence.id).toBeNull();
  });

  it("rejects deferred wrappers", async () => {
    const analysis = await syntax({
      name: "functions.exec",
      input: {
        code: "if (false) await tools.exec_command({cmd: 'vtb --json add \"Ticket\" -l ticket'});",
      },
    });
    const recognized = ticketCommand(analysis);

    expect(recognized).toBe(false);
  });

  it.each([
    "",
    "Created ticket " + ID,
    "{",
    JSON.stringify({ command: "add", status: "created", task_id: "bad" }),
    JSON.stringify({ command: "show", status: "created", task_id: ID }),
    JSON.stringify({ output, exit_code: 1 }),
    JSON.stringify({ output, exit_code: 0, session_id: 12 }),
  ])("rejects malformed/failed/partial output %s", (text) => {
    expect(createdTicketId(text)).toBeNull();
  });

  it("correlates IDs and ignores child results and assistant claims", async () => {
    for (const r of [
      result("other"),
      result("a", { isError: true }),
      result("a", { parentToolUseId: "child" }),
    ]) {
      const evidence = await creationEvidence(
        [call('vtb --json add "Ticket" -l ticket'), r],
        syntax
      );

      expect(evidence.id).toBeNull();
    }
  });

  it("uses the latest incremental result and deduplicates replay", async () => {
    const c = call('vtb --json add "Ticket" -l ticket');

    const evidence = await creationEvidence(
      [c, result("a", { result: "{" }), c, result(), result()],
      syntax
    );

    expect(evidence.id).toBe(ID);
  });

  it("refuses multiple creations and bounded processing", async () => {
    const firstCall = call('vtb --json add "Ticket" -l ticket');
    const secondCall = call('vtb --json add "Other" -l ticket', "b");
    const firstResult = result();
    const secondResult = result("b");
    const messages = [firstCall, secondCall, firstResult, secondResult];

    const evidence = await creationEvidence(messages, syntax);

    expect(evidence.diagnostic).toContain("ambiguous");

    const oversizedMessages = Array(129).fill(firstCall);
    const oversizedEvidence = await creationEvidence(oversizedMessages, syntax);

    expect(oversizedEvidence.id).toBeNull();
  });
});

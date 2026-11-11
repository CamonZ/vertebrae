import type { ChatMessage } from "../../stores/chatStore";
import type {
  ActivityAnalysis,
  ActivityInput,
} from "../../components/thread/toolActivity/types";
import { associationSyntax } from "../../components/thread/toolActivity/useActivities";

const UUID = /^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/i;
const object = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

/** Only one literal, unconditional invocation per tool call is supported. */
export function ticketCommand(analysis: ActivityAnalysis): boolean {
  if (
    analysis.analysisState ||
    analysis.failure ||
    analysis.operations.length !== 1
  )
    return false;

  const op = analysis.operations[0];
  const command = op.literalCommand;

  if (
    !command ||
    command.name !== "vtb" ||
    op.relationships.some(
      (r) =>
        ![
          "nested invocation (requested)",
          "shell wrapper (requested)",
        ].includes(r)
    )
  )
    return false;

  const args = [...command.args];
  if (args[0] === "--json") args.shift();
  if (args.shift() !== "add") return false;

  // Parse option values so text in a title/description cannot masquerade as flags.
  let title = false;
  let level: string | undefined;
  let json = command.args[0] === "--json";

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];

    if (arg === "--json") {
      json = true;
      continue;
    }

    if (
      [
        "-l",
        "--level",
        "-d",
        "--description",
        "-p",
        "--priority",
        "-t",
        "--tags",
        "--parent",
        "--depends-on",
        "--workflow",
        "--worktree",
      ].includes(arg)
    ) {
      const value = args[++i];
      if (!value) return false;

      if (arg === "-l" || arg === "--level") {
        if (level !== undefined) return false;
        level = value;
      }
    } else if (arg.startsWith("--level=")) {
      if (level !== undefined) return false;
      level = arg.slice(8);
    } else if (arg.startsWith("-") || title) return false;
    else title = true;
  }

  return title && json && level === "ticket";
}

/** Accept raw CLI JSON or the completed exec_command envelope, never substring IDs. */
export function createdTicketId(result: string): string | null {
  if (result.length > 32_000) return null;

  try {
    let value: unknown = JSON.parse(result);

    if (object(value) && "output" in value) {
      if (
        value.exit_code !== 0 ||
        value.session_id != null ||
        typeof value.output !== "string"
      )
        return null;

      value = JSON.parse(value.output);
    }

    return object(value) &&
      value.command === "add" &&
      value.status === "created" &&
      typeof value.task_id === "string" &&
      UUID.test(value.task_id)
      ? value.task_id.toLowerCase()
      : null;
  } catch {
    return null;
  }
}

function callInput(
  m: Extract<ChatMessage, { kind: "tool_call" }>
): ActivityInput | null {
  if (m.input.length > 32_000) return null;

  try {
    const input: unknown = JSON.parse(m.input);
    return object(input) ? { name: m.toolName, input } : null;
  } catch {
    return ["exec", "functions.exec"].includes(m.toolName)
      ? { name: m.toolName, input: { code: m.input } }
      : null;
  }
}

/** Called only at turn completion. Replays and incremental deliveries share tool identity. */
export async function creationEvidence(
  messages: readonly ChatMessage[],
  syntax = associationSyntax
): Promise<{ id: string | null; diagnostic: string | null }> {
  const fail = (diagnostic: string) => ({ id: null, diagnostic });

  if (messages.length > 128 || messages.some((m) => m.kind === "error"))
    return fail(
      "Ticket creation evidence exceeded its limit or the turn failed."
    );

  const calls = new Map<string, Extract<ChatMessage, { kind: "tool_call" }>>();
  const results = new Map<
    string,
    Extract<ChatMessage, { kind: "tool_result" }>
  >();

  for (const m of messages) {
    if ("parentToolUseId" in m && m.parentToolUseId) continue;
    if (m.kind === "tool_call") calls.set(m.toolId, m);
    if (m.kind === "tool_result") results.set(m.toolId, m);
  }

  const ids: string[] = [];

  for (const call of calls.values()) {
    const input = callInput(call);
    if (!input) continue;

    const analysis = await syntax(input);

    if (analysis.analysisState || analysis.failure)
      return fail("Ticket creation syntax could not be verified.");
    if (analysis.operations.length !== 1)
      return fail(
        "Compound tool calls cannot establish unambiguous ticket creation."
      );

    if (!ticketCommand(analysis)) {
      const command = analysis.operations[0]?.literalCommand;
      if (command?.name === "vtb" && command.args.includes("add"))
        return fail(
          "Ticket creation requires a supported JSON ticket command."
        );
      continue;
    }

    const result = results.get(call.toolId);
    const id =
      result && !result.isError ? createdTicketId(result.result) : null;
    if (!id)
      return fail(
        "Ticket creation requires a completed successful JSON result correlated to its command."
      );

    ids.push(id);
  }
  if (ids.length === 1) return { id: ids[0], diagnostic: null };

  const diagnostic =
    ids.length > 1
      ? "Multiple ticket creations are ambiguous. Select the ticket manually."
      : "No single supported ticket creation was confirmed. Use vtb --json add with an explicit ticket level.";

  return fail(diagnostic);
}

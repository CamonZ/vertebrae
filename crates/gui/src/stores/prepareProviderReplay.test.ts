import { expect, it } from "vitest";
import type { ChatMessage } from "./chatStore";
import {
  mergeProjectedReplay,
  prepareProviderReplay,
  type ReplayPreparation,
} from "./prepareProviderReplay";

const timestamp = "2026-11-03T12:00:00Z";
const line = (id: string, sequence: number) =>
  JSON.stringify({
    version: 1,
    event_id: id,
    stream_id: "s",
    sequence,
    correlation: { item_id: id, turn_id: "turn" },
    timestamp,
    type: "text",
    semantics: "snapshot",
    data: { text: id, completion_status: "completed" },
  });
const user = (text: string): ChatMessage => ({ kind: "user", text, timestamp });
const tool = (toolId: string): ChatMessage => ({
  kind: "tool_call",
  toolId,
  toolName: "Bash",
  input: "{}",
  timestamp,
});

it.each<Pick<ReplayPreparation, "kind" | "refresh">>([
  { kind: "initial", refresh: false },
  { kind: "initial", refresh: true },
  { kind: "older", refresh: true },
])(
  "rebasing a projection onto a newer transcript matches a fresh preparation (%o)",
  (mode) => {
    const installed = prepareProviderReplay({
      ...mode,
      kind: "initial",
      refresh: false,
      lines: [line("b", 2)],
      context: { id: "s", providerResumeId: null },
      previousInstalled: [],
      messages: [],
    }).messages;
    const base: ReplayPreparation = {
      ...mode,
      lines: [line("a", 1), line("b", 2)],
      context: { id: "s", providerResumeId: null },
      previousInstalled: mode.refresh ? installed : [],
      messages: [...installed, user("question")],
    };
    const newer = {
      ...base,
      messages: [...base.messages, tool("tool"), user("follow-up")],
    };

    const stale = prepareProviderReplay(base);
    const rebased = mergeProjectedReplay(stale.projected, newer);
    const fresh = prepareProviderReplay(newer);

    expect(rebased).toEqual({
      messages: fresh.messages,
      installedMessageCount: fresh.installedMessageCount,
    });
    expect(rebased.messages.map((message) => message.kind)).toContain(
      "tool_call"
    );
  }
);

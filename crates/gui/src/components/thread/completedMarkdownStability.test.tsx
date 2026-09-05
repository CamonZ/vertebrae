import type { ComponentProps } from "react";
import { render } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { ChatMessages } from "../ChatWindow/ChatMessages";
import type { ChatMessage } from "../../stores/chatStore";
import type { TaskRun, StepExecution, SessionLog } from "../../bindings";
import { runToThreads, conversationEventsToThread } from "./normalize";
import { Thread } from "./Thread";

const parses = vi.hoisted(() => vi.fn());
vi.mock("react-markdown", async () => {
  const actual = await vi.importActual<typeof import("react-markdown")>("react-markdown");
  const Markdown = actual.default;
  return {...actual, default: (props: ComponentProps<typeof Markdown>) => {
    parses(props.children);
    return <Markdown {...props} />;
  }};
});

const timestamp = "2026-09-05T12:00:00Z";
const history = (name: string): ChatMessage => ({kind: "assistant", itemId: `${name}-history`,
  text: `**${name} complete**\n\n- preserved\n\n[link](https://example.com)`, timestamp, lifecycle: "completed"});
const partial = (name: string, text: string, completed = false): ChatMessage => ({
  kind: "assistant", itemId: `${name}-live`, text, timestamp,
  lifecycle: completed ? "completed" : "streaming", isPartial: !completed,
});

function Surface({name, messages, shared}: {name: string; messages: ChatMessage[]; shared: boolean | "trace"}) {
  if (shared === "trace") {
    const logs = messages.flatMap((m, i) => m.kind === "assistant" ? [{id: `${name}-${i}`, step_execution_id: name, format: "harness", created_at: timestamp,
      content: JSON.stringify({version: 1, event_id: `${name}-${i}`, stream_id: name, sequence: i,
        correlation: {turn_id: "turn", item_id: m.itemId}, timestamp,
        semantics: m.lifecycle === "streaming" ? "delta" : "snapshot", type: "text",
        data: {text: m.text, ...(m.lifecycle === "completed" ? {completion_status: "completed"} : {})}})} as SessionLog] : []);
    const [thread] = runToThreads({taskRun: {started_at: timestamp} as TaskRun,
      stepExecutions: [{id: name, started_at: timestamp, status: "in_progress", completed_at: null, step_type: "execute"} as StepExecution], logsByExecutionId: {[name]: logs}});
    return <Thread thread={thread} mode="timed" showHead={false} />;
  }
  if (shared) return <Thread mode="bare" showHead={false} thread={conversationEventsToThread(
    messages.flatMap(m => m.kind === "assistant" ? [{kind: "assistant_message" as const,
      text: m.text, timestamp: m.timestamp, itemId: m.itemId, lifecycle: m.lifecycle}] : [])
  )} />;
  return <ChatMessages sessionId={name} messages={messages} assistantLabel="Agent"
    isEmpty={false} isActive isWaiting={false} streamingAssistant={null} />;
}

describe.each([false, true, "trace"] as const)("completed prose stability (shared=%s)", shared => {
  it("never reparses unchanged completed items through interleaved conversation deltas", () => {
    parses.mockClear();
    let a = "  **first";
    let b = "  **second";
    let aDone = false;
    const view = () => <><section data-testid="a"><Surface name="a" shared={shared}
      messages={[history("a"), partial("a", a, aDone)]} /></section>
      <section data-testid="b"><Surface name="b" shared={shared}
        messages={[history("b"), partial("b", b)]} /></section></>;
    const {container, rerender} = render(view());
    const initialCalls = parses.mock.calls.length;
    expect(initialCalls).toBeGreaterThanOrEqual(2);
    const historyNodes = [...container.querySelectorAll(".markdown-content")];
    for (let i = 0; i < 8; i++) {
      if (i % 2) a += `\n  chunk ${i}`; else b += `\n  chunk ${i}`;
      rerender(view());
      expect(parses).toHaveBeenCalledTimes(initialCalls);
      expect([...container.querySelectorAll(".markdown-content")]).toEqual(historyNodes);
      expect(container.querySelector('[data-testid="a"] .evprose--plain')?.textContent).toBe(a);
      expect(container.querySelector('[data-testid="b"] .evprose--plain')?.textContent).toBe(b);
    }
    a += "**";
    aDone = true;
    rerender(view());
    expect(parses).toHaveBeenCalledTimes(initialCalls + 1);
    expect(parses).toHaveBeenLastCalledWith(a);
    expect(container.querySelector('[data-testid="a"] .evprose--plain')).toBeNull();
    for (let i = 0; i < 5; i++) { b += ` delta ${i}`; rerender(view()); }
    expect(parses).toHaveBeenCalledTimes(initialCalls + 1);
    expect(container.querySelector('[data-testid="b"] .evprose--plain')?.textContent).toBe(b);
    expect(container.querySelectorAll('a[href="https://example.com"]')).toHaveLength(2);
  });
});

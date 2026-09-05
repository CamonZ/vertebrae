import { useState } from "react";
import { createRoot } from "react-dom/client";
import { flushSync } from "react-dom";
import { ChatMessages } from "../src/components/ChatWindow/ChatMessages";
import { Thread } from "../src/components/thread";
import { runToThreads } from "../src/components/thread/normalize";
import "../src/index.css";
import "./style.css";

const stamp = "2026-09-05T12:00:00Z";
const history = (name: string) =>
  Array.from({ length: 6 }, (_, i) => ({
    kind: "assistant",
    itemId: `${name}-history-${i}`,
    timestamp: stamp,
    lifecycle: "completed",
    isPartial: false,
    text:
      `## ${name} completed ${i}\n\n` +
      Array.from(
        { length: 8 },
        (_, j) =>
          `- Preserved item ${j}: **formatting**, [link](https://example.com), and whitespace.\n`
      ).join("") +
      "\n```ts\nconst completed = {value: true};\n```\n",
  }));
const sample =
  '  **streaming sample**\n\n    indented text\twith tab\n```ts\nconst x = {answer: 42};\n```\n{"nested":{"ok":true}}\n```mermaid\ngraph TD\nA --> B\n```\n' +
  "longword".repeat(30) +
  "\n  trailing spaces  ";
let model = { a: "", b: "", aDone: false, bDone: false, mode: "local" };
let work: string[] = [];
(globalThis as any).__richWork = work;
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const frames: number[] = [];
const inputs: { trusted: boolean; delay: number }[] = [];
let running = false;
let previousFrame = 0;
function frame(now: number) {
  if (running && previousFrame) frames.push(now - previousFrame);
  previousFrame = now;
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);
const percentile = (values: number[], p: number) =>
  [...values].sort((a, b) => a - b)[
    Math.min(values.length - 1, Math.floor(values.length * p))
  ] || 0;
function Pane({ name }: { name: "a" | "b" }) {
  const complete = model[`${name}Done`];
  const messages = [
    ...history(name),
    {
      kind: "assistant",
      itemId: `${name}-partial`,
      text: model[name],
      timestamp: stamp,
      lifecycle: complete ? "completed" : "streaming",
      isPartial: !complete,
    },
  ];
  if (model.mode === "local")
    return (
      <ChatMessages
        sessionId={name}
        messages={messages as any}
        assistantLabel="Agent"
        isEmpty={false}
        isActive
        isWaiting={false}
        streamingAssistant={null}
      />
    );
  const logs = messages.map((m, i) => ({
    id: `${name}-${i}`,
    format: "harness",
    step_execution_id: name,
    created_at: stamp,
    content: JSON.stringify({
      version: 1,
      event_id: `${name}-${i}`,
      stream_id: name,
      correlation: { turn_id: "turn", item_id: m.itemId },
      timestamp: stamp,
      semantics: m.isPartial ? "delta" : "snapshot",
      type: "text",
      data: {
        text: m.text,
        ...(!m.isPartial ? { completion_status: "completed" } : {}),
      },
    }),
  }));
  const [thread] = runToThreads({
    taskRun: { started_at: stamp },
    stepExecutions: [
      {
        id: name,
        started_at: stamp,
        completed_at: null,
        status: "in_progress",
        step_type: "execute",
      },
    ],
    logsByExecutionId: { [name]: logs },
  } as any);
  return (
    <div className="trace-scroll">
      <Thread thread={thread} mode="timed" showHead={false} />
    </div>
  );
}
function App() {
  const [, update] = useState(0);
  const [status, setStatus] = useState("Ready");
  const [report, setReport] = useState<any[]>([]);
  const redraw = () => flushSync(() => update((v) => v + 1));
  async function benchmark() {
    const results = [];
    document.querySelector("textarea")?.focus();
    setReport([]);
    for (const mode of ["local", "trace"]) {
      model = { a: "", b: "", aDone: false, bDone: false, mode };
      redraw();
      await sleep(250);
      work.length = 0;
      frames.length = 0;
      inputs.length = 0;
      const costs = [];
      running = true;
      setStatus(
        `Streaming ${mode}: type below while both conversations update`
      );
      for (let i = 0; i < 120; i++) {
        const start = performance.now();
        const name = i % 2 ? "a" : "b";
        model[name] += i < 2 ? sample : `\n  delta ${i} **literal**`;
        redraw();
        costs.push(performance.now() - start);
        const input = document.querySelector("textarea")!;
        input.dispatchEvent(new InputEvent("input", { bubbles: true }));
        await sleep(100);
      }
      running = false;
      const streamingWork = work.length;
      const historyReparses = work.filter((text) =>
        text.includes(" completed ")
      ).length;
      const exactPartial = [...document.querySelectorAll(".pane")].every(
        (pane, i) =>
          pane.querySelector(".evprose:last-child") !== null &&
          [...pane.querySelectorAll(".evprose")].at(-1)?.textContent ===
            model[i ? "b" : "a"]
      );
      const beforeComplete = work.length;
      model.aDone = true;
      redraw();
      const completionWork = work.length - beforeComplete;
      const afterComplete = work.length;
      for (let i = 0; i < 10; i++) {
        model.b += ` later ${i}`;
        redraw();
        await sleep(30);
      }
      const aReparses = work
        .slice(afterComplete)
        .filter((text) => text === model.a).length;
      model.bDone = true;
      redraw();
      const result = {
        mode,
        streamingWork,
        historyReparses,
        exactPartial,
        completionWork,
        aReparses,
        updateP50: percentile(costs, 0.5),
        updateP95: percentile(costs, 0.95),
        frameP95: percentile(frames, 0.95),
        inputP95: percentile(
          inputs.map((x) => x.delay),
          0.95
        ),
        trustedInputs: inputs.filter((x) => x.trusted).length,
        trustedInputP95: percentile(
          inputs.filter((x) => x.trusted).map((x) => x.delay),
          0.95
        ),
        userAgent: navigator.userAgent,
      };
      results.push(result);
      setReport([...results]);
    }
    setStatus("Benchmark complete");
    await fetch("/results", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(results),
    });
  }
  function partialSample() {
    model = { a: sample, b: sample, aDone: false, bDone: true, mode: "local" };
    redraw();
    document
      .querySelectorAll('[data-testid="chat-messages-scroll"]')
      .forEach((el) => (el.scrollTop = el.scrollHeight));
    setStatus(
      "Visual sample: A is partial; B is completed. Select text, resize, and scroll."
    );
  }
  return (
    <main>
      <h1>Markdown item completion · WKWebView verification</h1>
      <div className="controls">
        <button onClick={benchmark}>Start benchmark</button>
        <button onClick={partialSample}>Show visual sample</button>
        <strong role="status">{status}</strong>
      </div>
      <textarea
        aria-label="Typing responsiveness probe"
        placeholder="Type here during streaming"
        onInput={(event) => {
          const start = performance.now();
          const trusted = event.isTrusted;
          requestAnimationFrame(() =>
            inputs.push({ trusted, delay: performance.now() - start })
          );
        }}
      />
      <div className="panes">
        <section className="pane">
          <h2>Conversation A</h2>
          <Pane name="a" />
        </section>
        <section className="pane">
          <h2>Conversation B</h2>
          <Pane name="b" />
        </section>
      </div>
      <pre aria-label="Measurements">{JSON.stringify(report, null, 2)}</pre>
    </main>
  );
}
createRoot(document.getElementById("root")!).render(<App />);

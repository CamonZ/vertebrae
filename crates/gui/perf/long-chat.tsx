import { useState } from "react";
import { createRoot } from "react-dom/client";
import { flushSync } from "react-dom";
import { ChatMessages } from "../src/components/ChatWindow/ChatMessages";
import { useUIStore } from "../src/stores/uiStore";
import { useChatStore } from "../src/stores/chatStore";
import type { ChatMessage } from "../src/stores/chatStore";
import "../src/index.css";
import "./style.css";

// Deterministic, synthetic long-chat workload rendered through the
// production ChatMessages path. Variants hold total fenced-code characters
// equal so plain prose, many small blocks and fewer large blocks compare.
type Variant =
  | "plain"
  | "small"
  | "large"
  | "diff-small"
  | "diff-large"
  | "payload-small"
  | "payload-large";
const params = new URLSearchParams(location.search);
const sizes = (params.get("sizes") ?? "25,100,200")
  .split(",")
  .map(Number)
  .filter((n) => n > 0);
const variants = (params.get("variants") ?? "plain,small,large").split(
  ","
) as Variant[];
const stamp = "2026-10-30T12:00:00Z";

const prose = (turn: number) =>
  `## Turn ${turn} findings\n\n` +
  Array.from(
    { length: 6 },
    (_, j) =>
      `- Step ${j}: updated \`module_${turn}_${j}.rs\` and checked [the docs](https://example.com/${turn}/${j}); **result** stayed within budget.\n`
  ).join("") +
  `\nThe change keeps \`HistoricalChatItems\` stable while the stream continues; see \`src/lib.rs:${turn}\` for context.\n`;

const codeLines = (turn: number, lines: number) =>
  Array.from(
    { length: lines },
    (_, i) =>
      `  let value_${i} = compute(${turn}, ${i}).map(|x| x * 2).unwrap_or_default(); // ${i}`
  ).join("\n");
// small: three ~10-line blocks per answer; large: one ~40-line block on
// every fourth answer at three times the size of three small blocks.
const fence = (lines: string) =>
  "\n```rust\nfn sample() {\n" + lines + "\n}\n```\n";
function answer(variant: Variant, turn: number) {
  if (variant === "small")
    return (
      prose(turn) + [0, 1, 2].map(() => fence(codeLines(turn, 10))).join("")
    );
  if (variant === "large")
    return prose(turn) + (turn % 4 === 0 ? fence(codeLines(turn, 120)) : "");
  return prose(turn);
}
function patch(turn: number, lines: number) {
  const path = `src/item_${turn}.rs`;
  return (
    `diff --git a/${path} b/${path}\n--- a/${path}\n+++ b/${path}\n@@ -1,${lines} +1,${lines} @@\n` +
    Array.from(
      { length: lines },
      (_, i) =>
        `-let value_${i} = compute(${turn}, ${i}).unwrap_or_default();\n+let value_${i} = compute(${turn}, ${i}).map(|x| x * 2).unwrap_or_default();\n`
    ).join("")
  );
}
function diffHistory(variant: Variant, turns: number): ChatMessage[] {
  const lines = variant.endsWith("large") ? 120 : 10;
  const annotated = variant.startsWith("diff-");
  const toolAnnotations = Object.fromEntries(
    Array.from({ length: turns }, (_, turn) => [
      `tool-${turn}`,
      {
        worktree_delta: {
          session_id: "perf",
          tool_id: `tool-${turn}`,
          kind: "worktree_delta",
          payload: {
            patch: patch(turn, lines),
            files: [{ path: `src/item_${turn}.rs`, status: "modified" }],
          },
        },
      },
    ])
  );
  useChatStore.setState({
    sessions: annotated ? { perf: { toolAnnotations } } : {},
  } as never);
  return Array.from({ length: turns }, (_, turn): ChatMessage[] => [
    {
      kind: "user",
      text: `Please update src/item_${turn}.rs`,
      timestamp: stamp,
    },
    {
      kind: "tool_call",
      toolName: annotated ? "Edit" : "apply_patch",
      toolId: `tool-${turn}`,
      input: JSON.stringify({ file_path: `/repo/src/item_${turn}.rs` }),
      timestamp: stamp,
    },
    {
      kind: "tool_result",
      toolId: `tool-${turn}`,
      result: "File updated",
      isError: false,
      timestamp: stamp,
    },
    ...(!annotated
      ? [
          {
            kind: "file_edit" as const,
            toolId: `tool-${turn}`,
            status: "completed",
            changes: [
              {
                path: `src/item_${turn}.rs`,
                kind: "update" as const,
                diff: patch(turn, lines),
              },
            ],
            timestamp: stamp,
          },
        ]
      : []),
    {
      kind: "assistant",
      itemId: `answer-${turn}`,
      text: prose(turn),
      lifecycle: "completed",
      timestamp: stamp,
    },
  ]).flat();
}
function history(variant: Variant, turns: number): ChatMessage[] {
  if (variant.startsWith("diff-") || variant.startsWith("payload-"))
    return diffHistory(variant, turns);
  useChatStore.setState({ sessions: {} });
  return Array.from({ length: turns }, (_, turn) => [
    {
      kind: "user" as const,
      text: `Please check item ${turn}: \`src/item_${turn}.ts\` and report.`,
      timestamp: stamp,
    },
    {
      kind: "tool_call" as const,
      toolName: "Read",
      toolId: `tool-${turn}`,
      input: JSON.stringify({ file_path: `/repo/src/item_${turn}.ts` }),
      timestamp: stamp,
    },
    {
      kind: "tool_result" as const,
      toolId: `tool-${turn}`,
      result: `export const item${turn} = ${turn};\n`.repeat(8),
      isError: false,
      timestamp: stamp,
    },
    {
      kind: "assistant" as const,
      itemId: `answer-${turn}`,
      text: answer(variant, turn),
      timestamp: stamp,
      lifecycle: "completed" as const,
    },
  ]).flat();
}

/** Hooks shared with perf/build.mjs and the trace and native drivers. */
const w = globalThis as typeof globalThis & {
  __richWork: string[];
  __snippetRenders: number;
  __phase?: (name: string) => void;
  __results?: unknown;
  __run: () => Promise<void>;
};
w.__richWork = [] as string[];
w.__snippetRenders = 0;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const nextFrame = () => new Promise<number>((r) => requestAnimationFrame(r));
const percentile = (values: number[], p: number) =>
  [...values].sort((a, b) => a - b)[
    Math.min(values.length - 1, Math.floor(values.length * p))
  ] ?? 0;
const round = (n: number) => Math.round(n * 10) / 10;

// Frame gaps double as a long-task proxy: WebKit has no longtask entries.
let frames: number[] = [];
let lastFrame = 0;
function tick(now: number) {
  if (lastFrame) frames.push(now - lastFrame);
  lastFrame = now;
  requestAnimationFrame(tick);
}
requestAnimationFrame(tick);
const frameStats = (gaps: number[]) => ({
  frameP95: round(percentile(gaps, 0.95)),
  frameMax: round(Math.max(0, ...gaps)),
  longFrames: gaps.filter((g) => g > 50).length,
  blockedMs: round(
    gaps.filter((g) => g > 50).reduce((s, g) => s + g - 16.7, 0)
  ),
});
/** Resolve once no frame gap above 50 ms has occurred for `quietMs`. */
async function settle(start: number, quietMs = 600, limitMs = 30_000) {
  let quietSince = performance.now();
  let seen = frames.length;
  while (performance.now() - start < limitMs) {
    await nextFrame();
    for (; seen < frames.length; seen++)
      if (frames[seen] > 50) quietSince = performance.now();
    if (performance.now() - quietSince >= quietMs) break;
  }
  return quietSince - start;
}
function domNodes(root: Node): number {
  let count = 0;
  const walk = (node: Node) => {
    count++;
    if (node instanceof Element && node.shadowRoot) walk(node.shadowRoot);
    for (let child = node.firstChild; child; child = child.nextSibling)
      walk(child);
  };
  walk(root);
  return count;
}
const mark = (name: string) => w.__phase?.(name);

let state: { messages: ChatMessage[] } = { messages: [] };
let redraw = () => {};
function Surface() {
  const [, update] = useState(0);
  redraw = () => flushSync(() => update((v) => v + 1));
  return (
    <div className="long-chat-pane">
      <ChatMessages
        sessionId="perf"
        projectPath="/repo"
        messages={state.messages}
        assistantLabel="Agent"
        isEmpty={state.messages.length === 0}
        isActive
        isWaiting={false}
        streamingAssistant={null}
      />
    </div>
  );
}

const streamText = (i: number) =>
  i === 0
    ? "Streaming answer with `inline` code and a [link](https://example.com).\n\n"
    : i === 20
      ? "\n```ts\nconst streamed = { ok: true };\n```\n"
      : ` delta ${i} **bold**`;

async function measure(variant: Variant, turns: number) {
  const base = history(variant, turns);
  const result: Record<string, unknown> = {
    variant,
    turns,
    messages: base.length,
    codeChars: base.reduce(
      (n, m) =>
        n +
        (m.kind === "assistant"
          ? (m.text.match(/```[\s\S]*?```/g) ?? []).join("").length
          : 0),
      0
    ),
  };
  state = { messages: [] };
  redraw();
  await sleep(300);

  // Cold-ish open: mount the whole history at once, then wait for
  // highlighting and layout to settle.
  mark(`mount:${variant}:${turns}`);
  w.__richWork.length = 0;
  w.__snippetRenders = 0;
  frames = [];
  let start = performance.now();
  state = { messages: base };
  redraw();
  // Payload diffs are collapsed by default in production. This workload
  // explicitly opens every payload row; include expansion in mount timing.
  if (variant.startsWith("payload-")) {
    flushSync(() => {
      document
        .querySelectorAll<HTMLButtonElement>(
          '.evtool-hd[aria-expanded="false"]'
        )
        .forEach((button) => button.click());
    });
  }
  const commitMs = performance.now() - start;
  const settleMs = await settle(start);
  const scroller = document.querySelector<HTMLElement>(
    '[data-testid="chat-messages-scroll"]'
  )!;
  result.mount = {
    commitMs: round(commitMs),
    settleMs: round(settleMs),
    ...frameStats(frames),
    markdownParses: w.__richWork.length,
    snippetRenders: w.__snippetRenders,
    domNodes: domNodes(scroller),
    scrollHeight: scroller.scrollHeight,
    diffViewports: scroller.querySelectorAll('[data-testid="diff-viewport"]')
      .length,
    annotationBlocks: scroller.querySelectorAll(
      '[data-testid="tool-change-block"]'
    ).length,
    pierreRoots: scroller.querySelectorAll("diffs-container").length,
    placeholders: scroller.querySelectorAll('[data-testid="diff-placeholder"]')
      .length,
    loadingDiffs: (scroller.textContent?.match(/Loading diff/g) ?? []).length,
    failedDiffs: (
      scroller.textContent?.match(/Diff could not be displayed/g) ?? []
    ).length,
  };

  if (variant.startsWith("diff-") || variant.startsWith("payload-")) {
    const counts = result.mount as {
      diffViewports: number;
      pierreRoots: number;
      placeholders: number;
      loadingDiffs: number;
      failedDiffs: number;
    };
    if (
      counts.diffViewports !== turns ||
      // Diffs far from the visible area stay plain until scrolled near.
      counts.pierreRoots + counts.placeholders !== turns ||
      counts.pierreRoots === 0 ||
      counts.loadingDiffs ||
      counts.failedDiffs
    )
      throw new Error(
        `Diff workload did not fully render: ${JSON.stringify(counts)}`
      );
  }

  // Scroll from the top at a steady reading pace (40 px per frame), back up
  // over the same range, and as a fast fling (400 px per frame).
  for (const [phase, from, step, steps] of [
    ["scroll", 0, 40, 240],
    ["scrollBack", 9600, -40, 240],
    ["fling", 0, 400, 90],
  ] as const) {
    mark(`${phase}:${variant}:${turns}`);
    if (phase !== "scrollBack") scroller.scrollTop = from;
    await settle(performance.now(), 300);
    frames = [];
    start = performance.now();
    for (let i = 1; i <= steps; i++) {
      scroller.scrollTop = from + step * i;
      await nextFrame();
    }
    result[phase] = {
      ms: round(performance.now() - start),
      ...frameStats(frames),
    };
    await settle(performance.now(), 300);
  }

  // Typing while idle: input handler to next frame.
  mark(`typing:${variant}:${turns}`);
  const input = document.querySelector("textarea")!;
  const delays: number[] = [];
  for (let i = 0; i < 40; i++) {
    const t = performance.now();
    input.value += "x";
    input.dispatchEvent(new InputEvent("input", { bubbles: true }));
    await nextFrame();
    delays.push(performance.now() - t);
    await sleep(25);
  }
  result.typing = {
    inputP50: round(percentile(delays, 0.5)),
    inputP95: round(percentile(delays, 0.95)),
  };

  // Stream a new keyed answer through `messages`, the production item path.
  mark(`stream:${variant}:${turns}`);
  w.__richWork.length = 0;
  w.__snippetRenders = 0;
  frames = [];
  const updates: number[] = [];
  const typingDuringStream: number[] = [];
  let text = "";
  for (let i = 0; i < 60; i++) {
    text += streamText(i);
    state = {
      messages: [
        ...base,
        {
          kind: "assistant",
          itemId: "live",
          text,
          timestamp: stamp,
          lifecycle: "streaming",
          isPartial: true,
        },
      ],
    };
    const t = performance.now();
    redraw();
    updates.push(performance.now() - t);
    const ti = performance.now();
    input.dispatchEvent(new InputEvent("input", { bubbles: true }));
    await nextFrame();
    typingDuringStream.push(performance.now() - ti);
    await sleep(33);
  }
  result.stream = {
    updateP50: round(percentile(updates, 0.5)),
    updateP95: round(percentile(updates, 0.95)),
    inputP95: round(percentile(typingDuringStream, 0.95)),
    ...frameStats(frames),
    historyParses: w.__richWork.filter(
      (t: string) => t !== text && !text.startsWith(t)
    ).length,
    streamParses: w.__richWork.length,
    snippetRenders: w.__snippetRenders,
  };

  // Theme switch: every Pierre instance re-highlights.
  mark(`theme:${variant}:${turns}`);
  frames = [];
  w.__snippetRenders = 0;
  start = performance.now();
  flushSync(() => useUIStore.getState().setCodeTheme("dark", "github-dark"));
  const themeCommit = performance.now() - start;
  const themeSettle = await settle(start);
  result.theme = {
    commitMs: round(themeCommit),
    settleMs: round(themeSettle),
    ...frameStats(frames),
    snippetRenders: w.__snippetRenders,
  };
  flushSync(() => useUIStore.getState().setCodeTheme("dark", "pierre-dark"));
  await settle(performance.now());
  mark(`diffOptions:${variant}:${turns}`);
  frames = [];
  start = performance.now();
  flushSync(() =>
    useUIStore
      .getState()
      .setDiffPreferences({ diffStyle: "split", lineDiffType: "char" })
  );
  const optionsCommit = performance.now() - start;
  const optionsSettle = await settle(start);
  result.diffOptions = {
    commitMs: round(optionsCommit),
    settleMs: round(optionsSettle),
    ...frameStats(frames),
  };
  flushSync(() => useUIStore.getState().resetDiffPreferences());
  await settle(performance.now());
  mark("idle");
  return result;
}

// Inline code and links on every chat surface, checked against a probe
// colored with the same tokens in the real engine's cascade.
const styleSample: ChatMessage[] = [
  {
    kind: "user",
    text: "User `inline` and [`linked`](https://example.com)",
    timestamp: stamp,
  },
  {
    kind: "assistant",
    itemId: "style",
    text: "Agent `inline`, [`code link`](https://example.com), [plain link](https://example.com), [`entity`](vtb://ticket/fdf310ee-2189-4ca5-adeb-26b93bc918c2) and `src/main.rs:12`.",
    timestamp: stamp,
    lifecycle: "completed",
  },
];
async function styleCheck() {
  const checks: Record<string, unknown>[] = [];
  const root = document.documentElement;
  for (const scheme of ["dark", "light"]) {
    root.classList.toggle("light", scheme === "light");
    root.classList.toggle("dark", scheme === "dark");
    for (const [fg, bg] of [
      [null, null],
      ["var(--color-info)", "var(--color-bg-2)"],
    ]) {
      if (fg) root.style.setProperty("--inline-code-fg", fg);
      else root.style.removeProperty("--inline-code-fg");
      if (bg) root.style.setProperty("--inline-code-bg", bg);
      else root.style.removeProperty("--inline-code-bg");
      state = { messages: styleSample };
      redraw();
      await nextFrame();
      const probe = document.createElement("span");
      probe.style.color = "var(--inline-code-fg)";
      probe.style.backgroundColor = "var(--inline-code-bg)";
      const link = document.createElement("span");
      link.style.color = "var(--link-fg)";
      document.body.append(probe, link);
      const want = getComputedStyle(probe);
      const wantLink = getComputedStyle(link).color;
      const pane = document.querySelector(".long-chat-pane")!;
      const surfaces = {
        userCode: pane.querySelector(".evrow--user code"),
        agentCode: pane.querySelector(".evprose code"),
        codeInLink: pane.querySelector(
          '.evprose [data-testid="external-url-link"] code'
        ),
        codeInEntityLink: pane.querySelector(
          '.evprose [data-testid="vtb-entity-link"] code'
        ),
        fileReference: pane.querySelector(
          '[data-testid="local-file-reference-link"]'
        ),
      };
      const plainLink = [
        ...pane.querySelectorAll('.evprose [data-testid="external-url-link"]'),
      ].find((a) => !a.querySelector("code"));
      const result: Record<string, unknown> = {
        scheme,
        inline: fg ? "custom" : "default",
        plainLink: plainLink && getComputedStyle(plainLink).color === wantLink,
      };
      for (const [name, el] of Object.entries(surfaces)) {
        const got = el && getComputedStyle(el);
        const ok =
          !!got &&
          got.color === want.color &&
          got.backgroundColor === want.backgroundColor;
        result[name] = ok
          ? true
          : got
            ? `${got.color} on ${got.backgroundColor}; want ${want.color} on ${want.backgroundColor}`
            : "missing";
      }
      checks.push(result);
      probe.remove();
      link.remove();
    }
  }
  root.style.removeProperty("--inline-code-fg");
  root.style.removeProperty("--inline-code-bg");
  root.classList.add("dark");
  root.classList.remove("light");
  return checks;
}

function App() {
  const [status, setStatus] = useState("Ready");
  const [report, setReport] = useState<unknown[]>([]);
  async function run() {
    const results: unknown[] = [];
    const styles = await styleCheck();
    for (const variant of variants)
      for (const turns of sizes) {
        setStatus(`Measuring ${variant} × ${turns} turns`);
        results.push(await measure(variant, turns));
        setReport([...results]);
        await fetch("/results", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            label: params.get("label"),
            userAgent: navigator.userAgent,
            complete: false,
            styles,
            results,
          }),
        });
      }
    state = { messages: [] };
    redraw();
    const payload = {
      complete: true,
      label: params.get("label") ?? "unlabelled",
      userAgent: navigator.userAgent,
      styles,
      results,
    };
    w.__results = payload;
    setStatus("Benchmark complete");
    await fetch("/results", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    }).catch(() => undefined);
  }
  w.__run = run;
  return (
    <main>
      <h1>Long chat rendering · {params.get("label") ?? "fixture"}</h1>
      <div className="controls">
        <button onClick={run}>Start benchmark</button>
        <strong role="status">{status}</strong>
      </div>
      <textarea aria-label="Typing probe" />
      <Surface />
      <pre aria-label="Measurements">{JSON.stringify(report, null, 2)}</pre>
    </main>
  );
}
createRoot(document.getElementById("root")!).render(<App />);
if (params.get("auto") === "1") setTimeout(() => w.__run(), 500);

// Drive perf/long-chat.html in headless Chrome over the DevTools protocol,
// record a timeline trace with CPU samples, and summarize each benchmark
// phase by category (scripting, style, layout, paint, GC) and by hot
// functions. Browser-only isolation aid; validate timings in WKWebView.
//
//   node perf/chrome-trace.mjs <url> <summary.json> [trace.json]
import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const [url, summaryPath, tracePath] = process.argv.slice(2);
if (!url || !summaryPath) {
  console.error(
    "usage: node perf/chrome-trace.mjs <url> <summary.json> [trace.json]"
  );
  process.exit(2);
}
const chrome =
  process.env.CHROME ??
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const port = 9333;
const proc = spawn(chrome, [
  "--headless=new",
  `--remote-debugging-port=${port}`,
  `--user-data-dir=${mkdtempSync(path.join(tmpdir(), "vtb-perf-chrome-"))}`,
  "--window-size=1200,900",
  "--no-first-run",
  "--disable-background-timer-throttling",
  "--disable-renderer-backgrounding",
  "about:blank",
]);
proc.stderr.on("data", () => undefined);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let target;
for (let i = 0; i < 50 && !target; i++) {
  await sleep(200);
  try {
    const list = await (await fetch(`http://127.0.0.1:${port}/json`)).json();
    target = list.find((t) => t.type === "page");
  } catch {
    // Chrome is still starting.
  }
}
const ws = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((r) => ws.addEventListener("open", r, { once: true }));
let id = 0;
const pending = new Map();
const listeners = new Map();
ws.addEventListener("message", ({ data }) => {
  const msg = JSON.parse(data);
  if (msg.id && pending.has(msg.id)) {
    pending.get(msg.id)(msg);
    pending.delete(msg.id);
  } else if (msg.method)
    listeners.get(msg.method)?.forEach((fn) => fn(msg.params));
});
const send = (method, params = {}) =>
  new Promise((resolve, reject) => {
    const n = ++id;
    pending.set(n, (msg) =>
      msg.error ? reject(new Error(msg.error.message)) : resolve(msg.result)
    );
    ws.send(JSON.stringify({ id: n, method, params }));
  });
const on = (method, fn) =>
  listeners.set(method, [...(listeners.get(method) ?? []), fn]);

await send("Page.enable");
await send("Runtime.enable");
const loaded = new Promise((r) => on("Page.loadEventFired", r));
await send("Page.navigate", { url });
await loaded;
await sleep(1000);

const events = [];
on("Tracing.dataCollected", ({ value }) => events.push(...value));
const traced = new Promise((r) => on("Tracing.tracingComplete", r));
await send("Tracing.start", {
  transferMode: "ReportEvents",
  traceConfig: {
    includedCategories: [
      "devtools.timeline",
      "disabled-by-default-devtools.timeline",
      "blink.user_timing",
      "v8.execute",
      "disabled-by-default-v8.cpu_profiler",
      "v8",
    ],
  },
});
await send("Runtime.evaluate", {
  expression:
    "globalThis.__phase = (n) => performance.mark('phase:' + n); globalThis.__run()",
  awaitPromise: true,
});
const { result } = await send("Runtime.evaluate", {
  expression: "JSON.stringify(globalThis.__results)",
  returnByValue: true,
});
await send("Tracing.end");
await traced;
ws.close();
proc.kill();
if (tracePath)
  writeFileSync(tracePath, JSON.stringify({ traceEvents: events }));

// ── analysis ────────────────────────────────────────────────────────────
const threadNames = new Map();
for (const e of events)
  if (e.ph === "M" && e.name === "thread_name")
    threadNames.set(`${e.pid}:${e.tid}`, e.args.name);
const marks = events
  .filter(
    (e) => e.cat?.includes("blink.user_timing") && e.name.startsWith("phase:")
  )
  .sort((a, b) => a.ts - b.ts);
const mainKey = marks.length ? `${marks[0].pid}:${marks[0].tid}` : null;
const phases = marks.map((m, i) => ({
  name: m.name.slice(6),
  start: m.ts,
  end: marks[i + 1]?.ts ?? Infinity,
}));
const phaseOf = (ts) => phases.find((p) => ts >= p.start && ts < p.end);

const category = (name) => {
  if (
    /^(Layout|UpdateLayoutTree|InvalidateLayout|ScheduleStyleRecalculation)$/.test(
      name
    )
  )
    return name === "Layout" ? "layout" : "style";
  if (/RecalculateStyles|ParseAuthorStyleSheet|StyleInvalidator/.test(name))
    return "style";
  if (/Paint|Raster|Layerize|Composite|UpdateLayer|PrePaint|Commit/.test(name))
    return "paint";
  if (/GC|GarbageCollect/.test(name)) return "gc";
  if (/HitTest/.test(name)) return "hittest";
  return "scripting";
};
// Self time per category on each thread, from nested complete events.
const perThread = new Map();
const byThread = new Map();
for (const e of events)
  if (e.ph === "X" && e.dur !== undefined) {
    const key = `${e.pid}:${e.tid}`;
    if (!byThread.has(key)) byThread.set(key, []);
    byThread.get(key).push(e);
  }
const ensure = (obj, k) => (obj[k] ??= {});
for (const [key, list] of byThread) {
  list.sort((a, b) => a.ts - b.ts || b.dur - a.dur);
  const stack = [];
  const close = (until) => {
    while (stack.length && stack.at(-1).ts + stack.at(-1).dur <= until) {
      const done = stack.pop();
      const phase = phaseOf(done.ts);
      if (!phase || done.self <= 0) continue;
      const bucket = ensure(
        ensure(perThread, phase.name),
        key === mainKey ? "main" : (threadNames.get(key) ?? key)
      );
      const c = category(done.name);
      bucket[c] = (bucket[c] ?? 0) + done.self / 1000;
    }
  };
  for (const e of list) {
    close(e.ts);
    if (stack.length) stack.at(-1).self -= e.dur;
    stack.push({ ...e, self: e.dur });
  }
  close(Infinity);
}

// CPU samples arrive on a sampler thread, tied to their Profile by id.
// Main-thread and worker profiles are summarized separately.
const profiles = new Map();
for (const e of events)
  if (e.name === "Profile")
    profiles.set(`${e.pid}:${e.id}`, {
      thread: `${e.pid}:${e.tid}` === mainKey ? "main" : "workers",
      ts: e.args.data.startTime,
      nodes: new Map(),
    });
const samples = [];
for (const e of events) {
  const profile = e.name === "ProfileChunk" && profiles.get(`${e.pid}:${e.id}`);
  if (!profile) continue;
  const data = e.args.data.cpuProfile ?? {};
  for (const n of data.nodes ?? [])
    profile.nodes.set(n.id, {
      name: n.callFrame.functionName || "(anonymous)",
      url: n.callFrame.url,
      parent: n.parent,
    });
  (data.samples ?? []).forEach((s, i) => {
    const previous = profile.ts;
    profile.ts += e.args.data.timeDeltas?.[i] ?? 0;
    samples.push({
      profile,
      node: s,
      ts: profile.ts,
      dt: (profile.ts - previous) / 1000,
    });
  });
}
const label = (n) =>
  `${n.name} ${n.url ? path.basename(n.url).replace(/-[\w-]{8}\.js$/, "") : ""}`.trim();
const functions = {};
for (const s of samples) {
  const phase = phaseOf(s.ts);
  if (!phase) continue;
  let node = s.profile.nodes.get(s.node);
  if (!node || ["(idle)", "(program)", "(root)"].includes(node.name)) continue;
  const f = ensure(ensure(functions, phase.name), s.profile.thread);
  const self = ensure(f, "self");
  self[label(node)] = (self[label(node)] ?? 0) + s.dt;
  const seen = new Set();
  const inclusive = ensure(f, "inclusive");
  for (; node; node = s.profile.nodes.get(node.parent)) {
    const l = label(node);
    if (seen.has(l)) continue;
    seen.add(l);
    inclusive[l] = (inclusive[l] ?? 0) + s.dt;
  }
}
const top = (obj, n) =>
  Object.fromEntries(
    Object.entries(obj ?? {})
      .sort((a, b) => b[1] - a[1])
      .slice(0, n)
      .map(([k, v]) => [k, Math.round(v * 10) / 10])
  );
const round = (obj) =>
  Object.fromEntries(
    Object.entries(obj).map(([k, v]) => [
      k,
      typeof v === "number" ? Math.round(v * 10) / 10 : round(v),
    ])
  );
const summary = {
  url,
  results: JSON.parse(result.value),
  phases: Object.fromEntries(
    phases
      .filter((p) => p.name !== "idle")
      .map((p) => [
        p.name,
        {
          wallMs:
            Math.round((Math.min(p.end, marks.at(-1).ts) - p.start) / 100) / 10,
          threads: round(perThread[p.name] ?? {}),
          mainSelfTop: top(functions[p.name]?.main?.self, 15),
          mainInclusiveTop: top(functions[p.name]?.main?.inclusive, 30),
          workerSelfTop: top(functions[p.name]?.workers?.self, 8),
        },
      ])
  ),
};
writeFileSync(summaryPath, JSON.stringify(summary, null, 2) + "\n");
console.log(
  `wrote ${summaryPath} (${events.length} trace events, ${samples.length} samples)`
);

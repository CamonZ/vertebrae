/**
 * View-scope filtering for the Traces stream — the canonical filter-chip model.
 *
 * A single `view` narrows the rendered thread stream by message type (or agent
 * model), the way the canonical design's scope chips do. Counts feed the chip
 * badges. Applied to the CENTER stream only; the rail keeps the full tree.
 */

import type {
  AgentMessage,
  Message,
  Thread,
  Turn,
} from "../thread/types";

/** Built-in (type-based) chip ids. Model ids (e.g. "codex") are dynamic. */
export type ViewId =
  | "all"
  | "threads"
  | "turns"
  | "tools"
  | "system"
  | "errors"
  | (string & {});

export interface ViewCounts {
  all: number;
  threads: number;
  turns: number;
  tools: number;
  system: number;
  errors: number;
  /** Normalized model id → agent-message count (e.g. { codex: 12, claude: 2 }). */
  models: Record<string, number>;
}

/** Collapse a raw model id / speaker into a short chip id. */
export function normalizeModel(
  model: string | undefined,
  speaker?: string
): string | null {
  const raw = (model ?? speaker ?? "").toLowerCase();
  if (!raw) return null;
  if (raw.includes("claude")) return "claude";
  if (raw.includes("gpt") || raw.includes("codex")) return "codex";
  // Fall back to the first word of the model id.
  const word = raw.replace(/^agent\s*·\s*/, "").split(/[\s·/]/)[0];
  return word || null;
}

function eachThread(threads: readonly Thread[], fn: (t: Thread) => void): void {
  for (const t of threads) {
    fn(t);
    for (const turn of t.turns) {
      for (const m of turn.messages) {
        if (m.type === "spawn") eachThread([m.thread], fn);
      }
    }
  }
}

export function computeViewCounts(threads: readonly Thread[]): ViewCounts {
  const c: ViewCounts = {
    all: 0,
    threads: 0,
    turns: 0,
    tools: 0,
    system: 0,
    errors: 0,
    models: {},
  };
  eachThread(threads, (t) => {
    c.threads += 1;
    c.turns += t.turns.length;
    for (const turn of t.turns) {
      for (const m of turn.messages) {
        if (m.type === "spawn") continue; // counted via its own thread
        c.all += 1;
        if (m.type === "tool") c.tools += 1;
        else if (m.type === "system") c.system += 1;
        else if (m.type === "error") c.errors += 1;
        else if (m.type === "agent") {
          const id = normalizeModel(
            (m as AgentMessage).model,
            (m as AgentMessage).speaker
          );
          if (id) c.models[id] = (c.models[id] ?? 0) + 1;
        }
      }
    }
  });
  return c;
}

const STRUCTURAL_VIEWS = new Set(["all", "threads", "turns"]);

/** Does a non-spawn message pass the active view? */
function messagePassesView(m: Message, view: ViewId): boolean {
  if (STRUCTURAL_VIEWS.has(view)) return true;
  if (view === "tools") return m.type === "tool";
  if (view === "system") return m.type === "system";
  if (view === "errors") return m.type === "error";
  // A model chip: keep agent messages on that model.
  if (m.type === "agent") {
    return (
      normalizeModel((m as AgentMessage).model, (m as AgentMessage).speaker) ===
      view
    );
  }
  return false;
}

/** Concatenate a message's searchable text. */
function messageText(m: Message): string {
  switch (m.type) {
    case "user":
    case "system":
      return [m.label, m.text, typeof m.body === "string" ? m.body : ""].join(" ");
    case "agent":
      return [m.speaker, m.model, typeof m.prose === "string" ? m.prose : ""].join(" ");
    case "tool":
      return [m.name, m.cmd, m.em, m.summary, typeof m.body === "string" ? m.body : ""].join(" ");
    case "error":
      return [m.title, m.sub].join(" ");
    case "wait":
      return m.text ?? "";
    case "result":
      return m.body ?? "";
    case "activity":
      return [m.label, m.text].join(" ");
    default:
      return "";
  }
}

/** Filter one thread's turns by view + search, recursing into spawns. Returns
 *  null when nothing in the thread (or its descendants) matches. */
function filterThread(t: Thread, view: ViewId, q: string): Thread | null {
  const turns: Turn[] = [];
  for (const turn of t.turns) {
    const messages: Message[] = [];
    for (const m of turn.messages) {
      if (m.type === "spawn") {
        const child = filterThread(m.thread, view, q);
        if (child) messages.push({ ...m, thread: child });
        continue;
      }
      if (!messagePassesView(m, view)) continue;
      if (q && !messageText(m).toLowerCase().includes(q)) continue;
      messages.push(m);
    }
    if (messages.length > 0) turns.push({ ...turn, messages });
  }
  if (turns.length === 0) return null;
  return { ...t, turns };
}

export function filterThreadsByView(
  threads: readonly Thread[],
  view: ViewId,
  search: string
): Thread[] {
  const q = search.trim().toLowerCase();
  if ((view === "all" || STRUCTURAL_VIEWS.has(view)) && !q) {
    return threads as Thread[];
  }
  const out: Thread[] = [];
  for (const t of threads) {
    const filtered = filterThread(t, view, q);
    if (filtered) out.push(filtered);
  }
  return out;
}

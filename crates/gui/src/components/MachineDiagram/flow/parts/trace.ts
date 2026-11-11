/**
 * trace · nested timings (catalogue "trace"): nested spans with a cursor.
 * Frame 460×210, footprint L; no ports, the spans nest inside the frame.
 * Durations from the gallery "done" story: spans start 0.3–1.4 s apart and
 * the cursor sweeps at 90 px per second.
 */
import type { PartKindDef } from "../registry";

/** One span for the drawing: `[row, x, start, end, name]`. */
type Span = [number, number, number, number, string];

interface TraceState {
  /** Spans opened with `stage` and not yet closed, outermost first. */
  open: { name: string; start: number }[];
  spans: Span[];
  /** Cursor sweep `[from, to]`. */
  cursor: [number, number] | null;
}

const PX = 90;
const xAt = (state: TraceState, t: number) =>
  120 + (t - (state.cursor?.[0] ?? t)) * PX;

function close(state: TraceState, t: number) {
  for (let i = state.open.length - 1; i >= 0; i--) {
    const s = state.open[i];
    state.spans.push([i, xAt(state, s.start), s.start, t, s.name]);
  }
  state.open = [];
}

export const tracePart: PartKindDef<Record<string, unknown>, TraceState> = {
  kind: "trace",
  job: "nested timings",
  family: "observability",
  footprint: "L",
  bb: [90, 92, 460, 210],
  status: { x: 320, y: 334 },
  ports: {},
  init: () => ({ open: [], spans: [], cursor: null }),
  verbs: {
    span: {
      duration: 0.8,
      card: "none",
      description: "a leaf span, nested under the open spans",
      args: {
        name: { type: "string", default: "span" },
        seconds: { type: "number", min: 0, default: 0.8 },
      },
      compile({ t, out, state, args }) {
        const d = Number(args.seconds ?? 0.8);
        if (!state.cursor) state.cursor = [t, t + d];
        state.cursor[1] = Math.max(state.cursor[1], t + d);
        state.spans.push([
          state.open.length,
          xAt(state, t),
          t,
          t + d,
          String(args.name ?? "span"),
        ]);
        out.note(t, "recording", "dim");
        return { duration: d };
      },
    },
    stage: {
      duration: 0.5,
      card: "none",
      description: "open a span that later spans nest inside",
      args: { name: { type: "string", default: "request" } },
      compile({ t, out, state, args }) {
        if (!state.cursor) state.cursor = [t, t];
        state.open.push({ name: String(args.name ?? "request"), start: t });
        out.note(t, "recording", "dim");
      },
    },
    finish: {
      duration: 0.6,
      card: "none",
      description: "close every open span and name the outcome",
      args: {
        outcome: { type: "string", enum: ["ok", "error"], default: "ok" },
        total: {
          type: "string",
          description: "elapsed time for the status line, e.g. `3.1 s`",
        },
      },
      compile({ t, out, state, args }) {
        close(state, t);
        if (state.cursor) state.cursor[1] = Math.max(state.cursor[1], t);
        const ok = args.outcome !== "error";
        out.note(
          t,
          ok
            ? `done${args.total ? ` · ${String(args.total)}` : ""}`
            : "slow · query failed",
          ok ? "green" : "red"
        );
      },
    },
  },
};

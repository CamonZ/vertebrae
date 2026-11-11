/** Flow-to-catalogue adapters. No gallery scenario or status prose is consulted. */
import type { ReactNode } from "react";
import { MACHINE_PARTS } from "../parts";
import type { CardRole } from "../palette";
import type { CompiledPart, CompiledPartStep } from "./registry";

type Drawing = (t: number, compiled: CompiledPart) => ReactNode;
const latest = (steps: readonly CompiledPartStep[], t: number) =>
  steps.filter((s) => s.t <= t).at(-1);
const strings = (value: unknown): readonly string[] | undefined =>
  Array.isArray(value) && value.every((v) => typeof v === "string")
    ? value
    : undefined;
/** Keep the last outcome visible until the next cycle starts. */
function cycle(
  steps: readonly CompiledPartStep[],
  t: number,
  starts: readonly string[],
  ends: readonly string[]
) {
  const start = latest(
    steps.filter((s) => starts.includes(s.verb)),
    t
  );
  const previous =
    start && steps.filter((s) => ends.includes(s.verb) && s.t < start.t).at(-1);
  const remaining = steps.filter((s) => !previous || s.t > previous.t);
  const end = remaining.find((s) => ends.includes(s.verb));
  return remaining.filter((s) => !end || s.t <= end.t);
}
const resultRole = (s: CompiledPartStep | undefined): CardRole =>
  s?.verb === "fail" || s?.args.outcome === "error" ? "red" : "green";

export const FLOW_DRAWINGS = {
  source: (t) => MACHINE_PARTS.source.draw(t, null),
  transform: (t, p) => {
    const step = latest(
      p.steps.filter((s) => s.verb === "transform"),
      t
    );
    return MACHINE_PARTS.transform.draw(t, {
      stampAt: step ? step.t + 0.65 : p.timeline.period + 1,
    });
  },
  splitter: (t, p) => {
    const step = latest(
      p.steps.filter((s) => s.verb === "split"),
      t
    );
    return MACHINE_PARTS.splitter.draw(t, {
      splitAt: step ? step.t + 0.65 : p.timeline.period + 1,
    });
  },
  client: (t, p) => {
    const action = latest(
      p.steps.filter((s) => s.verb !== "wait"),
      t
    );
    const done = action?.verb === "render" ? action.t + 0.35 : null;
    return MACHINE_PARTS.client.draw(t, {
      done,
      hang: action?.verb === "send" ? [action.end, p.timeline.period] : null,
      error: action?.args.outcome === "error",
    });
  },
  worker: (t, p) => {
    const stage = latest(
      p.steps.filter((s) => s.verb === "stage"),
      t
    );
    const stop =
      stage &&
      p.steps.find(
        (s) => s.t >= stage.t && ["finish", "fail", "cancel"].includes(s.verb)
      );
    const from = stage ? stage.t + 0.65 : p.timeline.period + 1;
    const to = stop
      ? stop.t + (stop.verb === "finish" ? Number(stop.args.work ?? 0) : 0.3)
      : p.timeline.period;
    return MACHINE_PARTS.worker.draw(t, {
      cl: [from, to],
      lights: stage
        ? Array.from({ length: 6 }, (_, i) => stage.end + 0.25 * i)
        : [],
      crash: stop?.verb === "fail" ? stop.t : null,
    });
  },
  router: (t, p) => {
    const turns = p.steps.filter((s) => ["route", "decide"].includes(s.verb));
    const current = latest(turns, t - 0.55);
    const down = current?.outcome.exit === "fallback";
    return MACHINE_PARTS.router.draw(t, {
      arm: [
        [0, 0],
        ...turns.map(
          (s) =>
            [
              s.t + 0.55,
              s.outcome.exit === "r1"
                ? -1
                : s.outcome.exit === "r2"
                  ? 0
                  : s.outcome.exit === "r3"
                    ? 1
                    : 2,
            ] as const
        ),
      ],
      down,
      fallback: down && current?.outcome.role !== "red",
      routes: strings(p.props.routes),
    });
  },
  joiner: (t, p) => {
    const steps = cycle(
      p.steps,
      t,
      ["wait", "join"],
      ["release", "fail", "cancel"]
    );
    const arrivals = steps.filter((s) => ["wait", "join"].includes(s.verb));
    return MACHINE_PARTS.joiner.draw(t, {
      rings: arrivals.map((s) => {
        const end = p.steps.find(
          (e) => e.t >= s.t && ["release", "fail", "cancel"].includes(e.verb)
        );
        return [
          [260, (s.entry ?? s.args.branch ?? "a") === "b" ? 250 : 150],
          s.t + 0.4,
          end ? end.t + 0.3 : p.timeline.period,
          resultRole(end),
        ];
      }),
    });
  },
  aggregator: (t, p) => {
    const steps = cycle(p.steps, t, ["record"], ["flush", "fail"]);
    const records = steps.filter((s) => s.verb === "record");
    const reduce = steps.find((s) => s.verb === "reduce");
    return MACHINE_PARTS.aggregator.draw(t, {
      items: records.map((s) => [
        s.t + 0.4,
        s.args.bad === true ? "red" : "ink",
      ]),
      squeezeAt: reduce?.t ?? p.timeline.period + 1,
    });
  },
  pipeline: (t, p) => {
    const steps = cycle(p.steps, t, ["stage"], ["finish", "fail", "cancel"]);
    const stages = steps.filter((s) => s.verb === "stage");
    return MACHINE_PARTS.pipeline.draw(t, {
      stages: strings(p.props.stages)?.slice(0, 3),
      lamps: stages.map((s, i) => {
        const end =
          stages[i + 1] ??
          p.steps.find(
            (e) => e.t >= s.t && ["finish", "fail", "cancel"].includes(e.verb)
          );
        return [end?.t ?? p.timeline.period + 1, resultRole(end)];
      }),
      rings: stages.map((s, i) => {
        const end =
          stages[i + 1] ??
          p.steps.find(
            (e) => e.t >= s.t && ["finish", "fail", "cancel"].includes(e.verb)
          );
        return [
          160 + 160 * Math.min(i, 2),
          s.t + 0.45,
          end?.t ?? p.timeline.period,
          resultRole(end),
        ];
      }),
    });
  },
  pool: (t, p) => {
    // Held card tracks include queue promotion, whose timing is decided by the verb.
    const slots = p.timeline.cards.flatMap((c) => {
      const end = c.legs.at(-1)?.route.points.at(-1);
      return end?.[1] === 190 ? [{ c, x: end[0] }] : [];
    });
    const waiter = p.timeline.cards.find(
      (c) =>
        c.legs.at(-1)?.route.points.at(-1)?.[0] === 118 &&
        c.born <= t &&
        c.dies > t
    );
    return MACHINE_PARTS.pool.draw(t, {
      seats: [230, 320, 410].slice(0, Number(p.props.seats ?? 3)),
      rings: slots.map(({ c, x }) => [
        x,
        c.born + 0.7,
        c.dies,
        resultRole(
          p.steps.find(
            (s) => s.verb === "release" && s.card?.id === c.id && s.t === c.dies
          )
        ),
      ]),
      wait: waiter ? [waiter.born + 0.35, waiter.dies] : null,
    });
  },
  boundary: (t, p) => {
    const cross = latest(
      p.steps.filter((s) => s.verb === "cross"),
      t
    );
    return MACHINE_PARTS.boundary.draw(t, {
      cut: cross?.args.outcome === "partition" ? cross.t + 0.3 : null,
      region: typeof p.props.region === "string" ? p.props.region : undefined,
    });
  },
  queue: (t, p) => {
    const deliveries = p.steps.filter((s) =>
      ["drain", "retry"].includes(s.verb)
    );
    const dead = p.steps.some((s) => s.verb === "fail");
    return MACHINE_PARTS.queue.draw(t, {
      cap: Number(p.props.slots ?? 5),
      cons:
        deliveries.length || dead
          ? deliveries.map(
              (s) => [s.t + 0.6, s.verb === "retry" ? "red" : "green"] as const
            )
          : null,
      dlq: dead,
    });
  },
  "event rail": (t, p) => {
    const sends = p.steps.filter((s) => s.verb === "send");
    const wait = p.steps.find((s) => s.verb === "wait");
    const resume =
      wait && p.steps.find((s) => s.verb === "resume" && s.t > wait.t);
    const last = sends.at(-1);
    return MACHINE_PARTS["event rail"].draw(t, {
      dots: sends.map((s) => {
        const role = s.args.role;
        return [
          s.t + 0.3,
          role === "amber" ? "ring" : role === "dim" ? "delta" : "msg",
          s.t + 1.2,
        ] as const;
      }),
      done: last ? last.t + 0.7 : null,
      fail: sends.some((s) => s.args.role === "red"),
      resume:
        wait && resume
          ? {
              arr: sends.map((s) => s.t + 0.3),
              rd: sends.map((s) =>
                s.t > wait.t && s.t < resume.t ? resume.t + 0.5 : s.t + 0.3
              ),
              cut: [wait.t, resume.t],
            }
          : null,
    });
  },
  retry: (t, p) => {
    const state = p.state as {
      lamps: [number, "red" | "green"][];
      rings: [number, number][];
    };
    return MACHINE_PARTS.retry.draw(t, {
      lamps: state.lamps,
      rings: state.rings,
    });
  },
  timeout: (t, p) => {
    const state = p.state as {
      fuse: {
        from: number;
        to: number | null;
        role: "green" | "red" | null;
      } | null;
      callee: [number, number | null] | null;
    };
    const end = p.timeline.period + 1;
    const fuse = state.fuse;
    const stop = fuse ? (fuse.to ?? end) : end;
    return MACHINE_PARTS.timeout.draw(t, {
      dl: fuse
        ? [fuse.from, fuse.from + Number(p.props.budget ?? 2) * 1.1]
        : [end, end + 1],
      ring: fuse
        ? [fuse.from, stop, fuse.role ?? "red"]
        : [end, end + 1, "red"],
      stop,
      svc: state.callee ? [state.callee[0], state.callee[1] ?? end] : null,
      fail: fuse?.role === "red",
      period: p.timeline.period,
    });
  },
  "rate limiter": (t, p) => {
    const state = p.state as {
      spent: (number | null)[];
      refilled: (number | null)[];
    };
    const cap = Number(p.props.tokens ?? 4);
    const never = p.timeline.period + 1;
    return MACHINE_PARTS["rate limiter"].draw(t, {
      tok: [0, 1, 2, 3].map((i) => [
        0,
        i >= cap ? 0 : (state.spent[i] ?? never),
        state.refilled[i] ?? never,
      ]),
      period: p.timeline.period,
    });
  },
  "circuit breaker": (t, p) => {
    const state = p.state as {
      fails: number[];
      open: [number, number | null] | null;
      half: [number, number | null] | null;
      cool: [number, number] | null;
      trial: number | null;
    };
    const never = p.timeline.period + 1;
    return MACHINE_PARTS["circuit breaker"].draw(t, {
      fails: state.fails.map((a) => a + 0.1).slice(0, 3),
      open: state.open
        ? [state.open[0], state.open[1] ?? never]
        : [never, never + 1],
      half: state.half ? [state.half[0], state.half[1] ?? never] : null,
      cool: state.cool ?? [never, never + 1],
      trial: state.trial ?? never,
      fail: p.steps.at(-1)?.verb === "fail" && state.open !== null,
    });
  },
  guard: (t, p) =>
    MACHINE_PARTS.guard.draw(t, {
      rings: p.steps
        .filter((s) => s.verb === "decide")
        .map(
          (s) =>
            [
              s.t + 0.4,
              s.t + 0.85,
              s.outcome.role === "red" ? "red" : "green",
            ] as const
        ),
    }),
  approval: (t, p) => {
    const state = p.state as {
      waitFrom: number | null;
      end: number | null;
      lift: number | null;
      failed: boolean;
      expired: boolean;
    };
    const never = p.timeline.period + 1;
    const from = state.waitFrom ?? never;
    return MACHINE_PARTS.approval.draw(t, {
      wait: [from, state.end ?? never],
      lift: state.lift != null ? [state.lift, never] : [never, never],
      ring:
        state.expired && state.end != null ? [from, state.end, "red"] : null,
      fail: state.failed,
    });
  },
  metric: (t, p) => {
    const state = p.state as {
      ev: number[];
      val: [number, string, "dim" | "ink" | "amber" | "red"][];
    };
    return MACHINE_PARTS.metric.draw(t, {
      ev: state.ev,
      val: state.val,
      period: p.timeline.period,
    });
  },
  trace: (t, p) => {
    const state = p.state as {
      spans: [number, number, number, number, string][];
      cursor: [number, number] | null;
    };
    return MACHINE_PARTS.trace.draw(t, {
      sp: state.spans,
      fail: p.steps.some(
        (s) => s.verb === "finish" && s.args.outcome === "error"
      ),
      cursor: state.cursor ?? [0.6, 3.7],
    });
  },
  alert: (t, p) => {
    const state = p.state as { fire: number | null; ack: number | null };
    return MACHINE_PARTS.alert.draw(t, {
      fire: state.fire ?? p.timeline.period + 1,
      ack: state.ack,
      fail: p.steps.some((s) => s.verb === "escalate"),
    });
  },
  store: (t, p) => {
    const widths = [150, 110, 170, 90] as const;
    const resident = Number(p.props.rows ?? 4);
    const list: [number, number, "edge" | "ink" | "amber"][] = Array.from(
      { length: resident },
      (_, i) => [-1, widths[i % 4], i % 4 === 0 || i % 4 === 3 ? "edge" : "ink"]
    );
    for (const s of p.steps) {
      if (s.t > t) break;
      if (s.verb === "record" && s.args.outcome !== "conflict")
        list.push([s.t + 0.65, 130, "amber"]);
      if (s.verb === "delete") list.pop();
    }
    const reads = p.steps.filter((s) => s.verb === "read" && s.t <= t);
    const missing = reads.filter((s) => s.args.outcome === "missing").at(-1);
    const ok = reads.filter((s) => s.args.outcome !== "missing").at(-1);
    return MACHINE_PARTS.store.draw(t, {
      rows: list,
      sweep: missing ? missing.t : null,
      read: ok ? ok.t - 0.05 : p.timeline.period + 1,
    });
  },
  cache: (t, p) => {
    const rows: Parameters<
      typeof MACHINE_PARTS.cache.draw
    >[1]["rows"][number][] = [
      { i: 0, w: 90, c: "ink" },
      { i: 1, w: 60, c: "edge" },
      { i: 2, w: 110, c: "ink" },
    ];
    const scan: [number, number][] = [];
    let slot = 3;
    for (const s of p.steps) {
      if (s.verb === "read") {
        const hit = s.outcome.exit === "answer";
        scan.push(hit ? [s.t + 0.45, s.t + 0.8] : [s.t + 0.5, s.t + 1.0]);
        if (hit)
          rows[1] = {
            ...rows[1],
            hl: [...(rows[1].hl ?? []), [s.t + 0.8, "green"]],
          };
      } else if (s.verb === "miss") {
        scan.push([s.t + 0.5, s.t + 1.0]);
        rows[1] = { ...rows[1], hl: [[s.t - 0.2, "amber"]], del: s.t };
      } else if (s.verb === "expire") {
        rows[1] = { ...rows[1], drain: [s.t, s.t + 0.5] };
      } else if (s.verb === "record" && s.args.outcome !== "error") {
        rows.push({ i: Math.min(slot++, 7), w: 80, c: "ink", add: s.t + 0.6 });
      }
    }
    return MACHINE_PARTS.cache.draw(t, { rows, scan });
  },
  document: (t, p) => {
    const edit = latest(
      p.steps.filter((s) => s.verb === "record"),
      t
    );
    return MACHINE_PARTS.document.draw(t, {
      ed: edit ? edit.t + 0.65 : p.timeline.period + 1,
      fail: edit?.args.outcome === "conflict",
    });
  },
  "state machine": (t) => MACHINE_PARTS["state machine"].draw(t, null),
  "reactive cell": (t, p) => {
    const val: [number, string, "ink"][] = [
      [0, String(p.props.value ?? "3"), "ink"],
    ];
    for (const s of p.steps.filter((x) => x.verb === "record"))
      val.push([s.t + 0.6, String(s.args.value ?? "4"), "ink"]);
    const lamp = (reader: string) => {
      const n = latest(
        p.steps.filter(
          (s) => s.verb === "notify" && (s.args.reader ?? "out1") === reader
        ),
        t
      );
      return [
        n ? n.t + 0.65 : p.timeline.period + 1,
        n?.args.outcome === "error" ? "red" : "green",
      ] as const;
    };
    return MACHINE_PARTS["reactive cell"].draw(t, {
      val,
      hit: [lamp("out1"), lamp("out2")],
    });
  },
  schema: (t, p) => {
    const fit: [number, CardRole][] = [];
    for (const s of p.steps.filter((x) => x.verb === "validate")) {
      if (s.args.outcome === "invalid") fit.push([s.t + 0.6, "red"]);
      else if (s.args.outcome === "migrated")
        fit.push([s.t + 0.4, "amber"], [s.t + 1.0, "green"]);
      else fit.push([s.t + 0.6, "green"]);
    }
    const migrated = latest(
      p.steps.filter(
        (s) => s.verb === "validate" && s.args.outcome === "migrated"
      ),
      t
    );
    return MACHINE_PARTS.schema.draw(t, {
      fit,
      glow: migrated ? [migrated.t + 0.4, migrated.t + 1.0] : null,
    });
  },
  transaction: (t, p) => {
    const commits: [number, CardRole][] = [];
    for (const s of p.steps) {
      if (s.verb === "commit")
        commits.push(
          s.args.outcome === "conflict" ? [s.t, "red"] : [s.t + 0.1, "green"]
        );
      else if (s.verb === "rollback") commits.push([s.t + 0.1, "red"]);
    }
    const landed = latest(
      p.steps.filter(
        (s) => s.verb === "commit" && s.args.outcome !== "conflict"
      ),
      t
    );
    return MACHINE_PARTS.transaction.draw(t, {
      commits,
      landed: landed ? landed.t + 0.1 : null,
    });
  },
  lock: (t, p) => {
    // Holder cards end seated on the latch; their rings and latch spans follow them.
    const holders = p.timeline.cards.filter((c) => {
      const end = c.legs.at(-1)?.route.points.at(-1);
      return end?.[0] === 320 && end?.[1] === 200;
    });
    const cl: number[] = [];
    const rings: [number, number, number, CardRole | null][] = holders.map(
      (c) => {
        const leg = c.legs.at(-1)!;
        const seated = leg.t + leg.d;
        const expired = p.steps.some(
          (s) => s.verb === "expire" && s.t + 0.1 === c.dies
        );
        const released = p.steps.some(
          (s) => s.verb === "release" && s.card?.id === c.id && s.t === c.dies
        );
        cl.push(seated + 0.05, c.dies < 1e8 ? c.dies + 0.05 : 1e3);
        return [
          320,
          seated,
          c.dies < 1e8 ? c.dies : p.timeline.period,
          released ? "green" : expired ? "edge" : null,
        ];
      }
    );
    return MACHINE_PARTS.lock.draw(t, {
      cl,
      rings,
      lease: p.steps.some((s) => s.verb === "expire" && s.t <= t),
      wait: null,
      pair: null,
      want: null,
    });
  },
  session: (t, p) => {
    const marks = (p.timeline.markers ?? [])
      .filter((m) => ["spawn", "resume", "close"].includes(m.kind))
      .sort((a, b) => a.t - b.t);
    const alive: [number, number][] = [];
    const spawn: number[] = [];
    for (const m of marks) {
      if (m.kind === "close") {
        const open = alive.at(-1);
        if (open && open[1] > m.t) open[1] = m.t;
      } else {
        alive.push([m.t, p.timeline.period + 1]);
        spawn.push(m.t);
      }
    }
    const lost = p.timeline.notes.find(
      (n) => n[1] === "resume failed · history lost"
    );
    if (lost) spawn.push(lost[0]);
    const bars: [number, number, "amber" | "ink"][] = [];
    for (const s of p.steps) {
      if (s.verb === "stage") bars.push([s.end - 0.1, 110, "amber"]);
      else if (s.verb === "finish" && s.card) bars.push([s.t, 150, "ink"]);
    }
    return MACHINE_PARTS.session.draw(t, {
      alive,
      spawn,
      crash: null,
      bars: bars.slice(0, 8),
      failedAt: lost ? lost[0] : null,
    });
  },
} satisfies Record<keyof typeof MACHINE_PARTS, Drawing>;

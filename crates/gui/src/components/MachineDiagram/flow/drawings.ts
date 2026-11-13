import { failureDetectorMachine } from "../parts/failureDetector";
import { fencingTokenMachine } from "../parts/fencingToken";
import { gossipMachine } from "../parts/gossip";
import { leaderElectionMachine } from "../parts/leaderElection";
import { quorumMachine } from "../parts/quorum";
import { replicationMachine } from "../parts/replication";
import { serviceRegistryMachine } from "../parts/serviceRegistry";
import { shardRingMachine } from "../parts/shardRing";
import { twoPhaseCommitMachine } from "../parts/twoPhaseCommit";
import { versionVectorMachine } from "../parts/versionVector";
/** Flow-to-catalogue adapters. No gallery scenario or status prose is consulted. */
import { createContext, useContext, type ReactNode } from "react";
import type { LampStep } from "../geometry";
import type { CardRole, StateRole } from "../palette";
import { MACHINE_PARTS } from "../parts";
import { TL, type TileSpec } from "../parts/eventTiles";
import type { StatusNote } from "../timeline";
import { upcastPlan } from "./parts/upcaster";
import type { CompiledPart, CompiledPartStep } from "./registry";

export type Drawing = (t: number, compiled: CompiledPart) => ReactNode;

/** Protocol specs carry the gallery's mechanism state under `extra`. */
function protocolDrawing<E>(draw: (t: number, extra: E) => ReactNode): Drawing {
  return (t, p) => draw(t, (p.state as { extra: E }).extra);
}

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
  replication: protocolDrawing(replicationMachine.draw),
  quorum: protocolDrawing(quorumMachine.draw),
  "leader election": protocolDrawing(leaderElectionMachine.draw),
  "failure detector": protocolDrawing(failureDetectorMachine.draw),
  gossip: protocolDrawing(gossipMachine.draw),
  "shard ring": protocolDrawing(shardRingMachine.draw),
  "version vector": protocolDrawing(versionVectorMachine.draw),
  "fencing token": protocolDrawing(fencingTokenMachine.draw),
  "two-phase commit": protocolDrawing(twoPhaseCommitMachine.draw),
  "service registry": protocolDrawing(serviceRegistryMachine.draw),

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
  "event store": (t, p) => {
    const X = (i: number) => 162 + 44 * i;
    let n = Math.min(7, Number(p.props.events ?? 4));
    const tl = Array.from({ length: n }, (_, i) =>
      TL(X(i), 170, String(i + 1))
    );
    const head: [number, number][] = [[0, Math.max(0, n - 1)]];
    for (const s of p.steps) {
      if (s.t > t) break;
      if (s.verb === "append") {
        const i = Math.min(n++, 7);
        tl.push(
          TL(X(i), 170, String(i + 1), s.t + 0.8, [
            [s.t + 0.8, "ink"],
            [s.t + 1.6, "edge"],
          ])
        );
        head.push([s.t + 0.8, i]);
      } else if (s.verb === "fail" && tl.length > 0) {
        tl[tl.length - 1].col.push([s.t + 0.75, "red"], [s.t + 1.4, "edge"]);
      } else if (s.verb === "read") {
        const from = Math.max(1, Number(s.args.from ?? 1));
        for (let k = 0; from - 1 + k < n; k++) {
          const a = s.t + 0.3 + 0.55 * k;
          tl[Math.min(from - 1 + k, tl.length - 1)]?.col.push(
            [a - 0.1, "amber"],
            [a + 0.5, "edge"]
          );
        }
      }
    }
    return MACHINE_PARTS["event store"].draw(t, { tl, head });
  },
  decider: (t, p) => {
    const st: StatusNote[] = [
      [0, String(p.props.state ?? "balance 50"), "ink"],
    ];
    const decisions = p.steps.filter(
      (s) => s.verb === "decide" || s.verb === "fail"
    );
    for (const s of decisions)
      if (s.verb === "decide" && s.args.state !== undefined)
        st.push([s.t + 1.9, String(s.args.state), "ink"]);
    const cur = latest(decisions, t);
    const cl: [number, number] = cur
      ? [cur.t + 0.65, cur.t + 2.0]
      : [1e3, 1e3 + 1];
    const lights = cur
      ? Array.from({ length: 6 }, (_, k) => cur.t + 0.75 + 0.25 * k)
      : [];
    const noop =
      cur?.verb === "decide" && Number(cur.args.events ?? 1) === 0
        ? cur.t + 2.0
        : null;
    return MACHINE_PARTS.decider.draw(t, { st, cl, lights, noop });
  },
  projection: (t, p) => {
    const WIDTHS = [110, 150, 95, 80] as const;
    let applied = Number(p.props.applied ?? 3);
    const rings: [number, number, StateRole][] = [];
    const rows: [number, number][][] = [
      [[0, 120]],
      [[0, 80]],
      [[0, 150]],
      [[0, 60]],
    ];
    const hl: [number, number][] = [];
    const ck: StatusNote[] = [[0, `#${applied}`, "ink"]];
    const fold = (r: number, hold: number, n: number) => {
      const row = n % 4;
      rows[row].push([r + hold, WIDTHS[row]]);
      hl.push([row, r + hold]);
      ck.push([r + hold, `#${n}`, "ink"]);
    };
    for (const s of p.steps) {
      if (s.t > t) break;
      if (s.verb === "fold") {
        rings.push([s.t + 0.6, s.t + 1.05, "green"]);
        fold(s.t + 0.6, 0.45, ++applied);
      } else if (s.verb === "fail") {
        rings.push([s.t + 0.6, s.t + 1.05, "red"]);
      } else if (s.verb === "replay") {
        const n = Number(s.args.events ?? 6);
        rows.forEach((l) => l.push([s.t + 0.5, 0]));
        ck.push([s.t + 0.5, "#0", "amber"]);
        for (let k = 0; k < n; k++) {
          const r = s.t + 1.0 + 0.38 * k + 0.45;
          rings.push([r, r + 0.2, "green"]);
          fold(r, 0.2, k + 1);
        }
        applied = n;
      }
    }
    return MACHINE_PARTS.projection.draw(t, { rings, rows, hl, ck });
  },
  snapshot: (t, p) => {
    const X = (i: number) => 146 + 44 * i;
    const events = Math.min(8, Number(p.props.events ?? 8));
    let snap = Math.min(events, Number(p.props.snapshot ?? 6));
    const tl = Array.from({ length: 8 }, (_, i) =>
      TL(X(i), 135, String(i + 1))
    );
    const rings: [number, number, StateRole][] = [];
    const br: {
      n: number;
      at: number;
      col: [number, StateRole][];
      gone?: number;
    }[] = snap > 0 ? [{ n: snap, at: -1, col: [[-1e9, "ink"]] }] : [];
    const st: StatusNote[] = [[0, "state · empty", "dim"]];
    const fold = (i: number, a: number) =>
      tl[i].col.push([a - 0.05, "amber"], [a + 0.4, "edge"]);
    for (const s of p.steps) {
      if (s.t > t) break;
      if (s.verb === "read" && snap > 0) {
        const tail = events - snap;
        const end = s.t + 0.9 + 0.5 * tail;
        rings.push([s.t + 0.3, end, "green"]);
        st.push([s.t + 0.65, `state · v${snap}`, "ink"]);
        for (let k = 0; k < tail; k++) {
          fold(snap + k, s.t + 0.8 + 0.5 * k);
          st.push([s.t + 1.3 + 0.5 * k, `state · v${snap + k + 1}`, "ink"]);
        }
      } else if (s.verb === "replay") {
        const end = s.t + 0.3 + 0.3 * events + 0.5;
        rings.push([s.t + 0.3, end, "green"]);
        for (let i = 0; i < events; i++) {
          fold(i, s.t + 0.3 + 0.3 * i);
          st.push([s.t + 0.75 + 0.3 * i, `state · v${i + 1}`, "ink"]);
        }
      } else if (s.verb === "snapshot") {
        if (br.length) br[br.length - 1].gone = s.t + 1.2;
        br.push({
          n: events,
          at: s.t + 1.05,
          col: [
            [-1e9, "green"],
            [s.t + 1.8, "ink"],
          ],
        });
        snap = events;
      } else if (s.verb === "fail" && br.length) {
        const last = br[br.length - 1];
        last.col.push([s.t + 0.5, "red"]);
        last.gone = s.t + 1.6;
        rings.push([s.t + 0.2, s.t + 0.65, "red"]);
        snap = 0;
      }
    }
    return MACHINE_PARTS.snapshot.draw(t, { tl, rings, br, st });
  },
  replay: (t, p) => {
    const X = (i: number) => 150 + 85 * i;
    const LAB = ["+50", "-30", "+50", "+10", "-20"];
    const tl = LAB.map((l, i) => TL(X(i), 160, l, -1, [], { w: 56 }));
    const ph: [number, number][] = [[0, -0.6]];
    const val: [number, number][] = [[0, 0]];
    const vn: StatusNote[] = [[0, "0", "dim"]];
    const barC: [number, StateRole][] = [[0, "ink"]];
    let diverges = false;
    let pos = 0;
    let v = 0;
    const step = (k: number, a: number, amount: number, bad: boolean) => {
      v += amount;
      ph.push([a, k]);
      val.push([a + 0.2, v]);
      vn.push([a + 0.2, String(v), "ink"]);
      tl[k].col.push([a, "amber"], [a + 0.45, bad ? "red" : "ink"]);
    };
    const AMT = [50, -30, 50, 10, -20];
    for (const s of p.steps) {
      if (s.t > t) break;
      if (s.verb === "replay") {
        const n = Number(s.args.upTo ?? 5);
        v = 0;
        for (let k = 0; k < n; k++)
          step(k, s.t + 0.9 + 0.55 * k, AMT[k], false);
        for (let k = n; k < LAB.length; k++) tl[k].dimAt = s.t + 0.6;
        pos = n;
      } else if (s.verb === "fold" && pos < AMT.length) {
        step(pos, s.t + 0.1, AMT[pos], false);
        pos++;
      } else if (s.verb === "fail") {
        diverges = true;
        v = 0;
        const amt = [50, -30, 45, 10, -20];
        for (let k = 0; k < 5; k++)
          step(k, s.t + 0.9 + 0.55 * k, amt[k], k === 2);
        barC.push([s.t + 2.4, "red"]);
        pos = 5;
      }
    }
    vn.push([p.timeline.period - 0.45, "0", "dim"]);
    return MACHINE_PARTS.replay.draw(t, {
      tl,
      ph,
      val,
      vn,
      barC,
      stored: diverges,
    });
  },
  upcaster: (t, p) => {
    const rings: [number, number, number, StateRole][] = [];
    for (const s of p.steps.filter((x) => x.verb === "upcast"))
      for (const stop of upcastPlan(Number(s.args.from ?? 2), s.t).stops)
        rings.push([stop.x, stop.from, stop.to, "green"]);
    return MACHINE_PARTS.upcaster.draw(t, { rings });
  },
  saga: (t, p) => {
    const XS = [170, 320, 470] as const;
    const rings: [number, number, number, number, StateRole][] = [];
    const lamps: LampStep[][] = [[], [], []];
    let at = 0;
    let waitFrom: number | null = null;
    for (const s of p.steps) {
      if (s.t > t) break;
      if (s.verb === "stage" && at < XS.length) {
        const a = waitFrom ?? s.t + 0.55;
        waitFrom = null;
        rings.push([XS[at], 165, a, a + 0.45, "green"]);
        lamps[at].push([a + 0.45, "green"]);
        at++;
      } else if (s.verb === "wait") {
        waitFrom = s.t;
      } else if (s.verb === "fail") {
        const i = Math.min(at, XS.length - 1);
        rings.push([XS[i], 165, waitFrom ?? s.t + 0.5, s.t + 0.95, "red"]);
        lamps[i].push([s.t + 0.95, "red"]);
        waitFrom = null;
      } else if (s.verb === "compensate") {
        let when = s.t + 0.75;
        for (let k = at - 1; k >= 0; k--) {
          if (k <= 1) rings.push([XS[k], 255, when - 0.3, when, "green"]);
          lamps[k].push([when, "off"]);
          when += 0.95;
        }
        at = 0;
      }
    }
    return MACHINE_PARTS.saga.draw(t, { rings, lamps });
  },
  outbox: (t, p) => {
    const rings: [number, number, StateRole][] = [];
    const pub: [number, "ink" | "amber"][] = [];
    const tl: TileSpec[] = [];
    const pending: TileSpec[] = [];
    let crash: number | null = null;
    let commit = 1e3;
    let down = false;
    let next = 1;
    for (const s of p.steps) {
      if (s.t > t) break;
      if (s.verb === "commit") {
        commit = s.t;
        const m = TL(
          262,
          225,
          `m${next++}`,
          s.t + 0.3,
          [[s.t + 0.3, "amber"]],
          { w: 44 }
        );
        tl.push(m);
        pending.push(m);
      } else if (s.verb === "publish" || s.verb === "retry") {
        down = false;
        const a = s.t + (s.verb === "retry" ? 1.1 : 0.5);
        const m = pending[0];
        if (!m) continue;
        rings.push([a + 0.6, a + 1.0, "green"]);
        pub.push([a + 1.55, s.verb === "retry" ? "amber" : "ink"]);
        if (s.verb === "publish" && s.args.marked === false) {
          crash = a + 1.75;
        } else {
          pending.shift();
          m.col.push([a + 1.6, "green"]);
          m.gone = a + 2.0;
        }
      } else if (s.verb === "fail") {
        down = true;
        const a = s.t + 0.5;
        rings.push([a + 0.6, a + 1.0, "red"]);
      }
    }
    return MACHINE_PARTS.outbox.draw(t, {
      tl,
      rings,
      pub,
      commit,
      down,
      crash,
    });
  },
  "consumer offset": (t, p) => {
    const X = (i: number) => 130 + 48 * i;
    const committed0 = Number(p.props.committed ?? 3);
    const tl = Array.from({ length: 8 }, (_, i) =>
      TL(X(i), 140, String(i + 1), -1, i < committed0 ? [[-1e8, "green"]] : [])
    );
    const rings: [number, number, StateRole][] = [];
    const ptr: [number, number][] = [[0, committed0]];
    const cm: StatusNote[] = [[0, `#${committed0}`, "ink"]];
    let read = committed0;
    let processed = committed0;
    let committed = committed0;
    let crash: number | null = null;
    for (const s of p.steps) {
      if (s.t > t) break;
      if (s.verb === "read" && read < 8) {
        ptr.push([s.t, read + 1]);
        tl[read].col.push([s.t - 0.05, "amber"]);
        read++;
      } else if (s.verb === "process" && processed < read) {
        rings.push([s.t, s.t + 0.25, "green"]);
        for (let i = processed; i < read; i++)
          tl[i].col.push([s.t + 0.25, "ink"]);
        processed = read;
      } else if (s.verb === "commit") {
        const n = Math.min(8, Number(s.args.upTo ?? Math.max(read, 1)));
        for (let i = committed; i < n; i++)
          tl[i].col.push([s.t + 0.05 * (i - committed), "green"]);
        cm.push([s.t, `#${n}`, "green"]);
        committed = Math.max(committed, n);
        read = Math.max(read, n);
      } else if (s.verb === "fail") {
        crash = s.t;
        for (let i = processed; i < committed; i++)
          tl[i].col.push([s.t + 0.1, "red"]);
        for (let i = committed; i < read; i++)
          tl[i].col.push([s.t + 0.1, "edge"]);
        ptr.push([s.t + 0.2, committed]);
        read = committed;
        processed = committed;
      }
    }
    return MACHINE_PARTS["consumer offset"].draw(t, {
      tl,
      rings,
      ptr,
      cm,
      crash,
    });
  },
  "idempotency guard": (t, p) => {
    const POS = (i: number) => 300 + 50 * i;
    const seen = (p.props.seen as readonly string[] | undefined) ?? [
      "k3",
      "k5",
    ];
    const tl = seen.map((k, i) => TL(POS(i), 160, k, -1, [], { w: 44 }));
    const rings: [number, number, StateRole][] = [];
    const erings: [number, number, StateRole][] = [];
    const fx: [number, "ink" | "red"][] = [];
    const applied = new Set<string>(seen);
    const live = new Map<string, TileSpec>(seen.map((k, i) => [k, tl[i]]));
    const flight = new Map<string, number>();
    for (const s of p.steps) {
      if (s.t > t) break;
      const key = String(s.args.key ?? s.card?.label ?? "");
      if (s.verb === "dedupe") {
        if (live.has(key) && !flight.has(key)) {
          rings.push([s.t + 0.55, s.t + 0.85, "green"]);
        } else {
          const again = applied.has(key);
          const col: [number, CardRole][] = [[s.t + 0.9, "amber"]];
          if (again) col.push([s.t + 1.8, "red"]);
          const m = TL(POS(live.size), 160, key, s.t + 0.9, col, { w: 44 });
          tl.push(m);
          live.set(key, m);
          flight.set(key, s.t + 1.1);
          rings.push([s.t + 0.6, s.t + 0.9, "green"]);
          fx.push([s.t + 1.5, again ? "red" : "ink"]);
          applied.add(key);
        }
      } else if (s.verb === "wait") {
        rings.push([s.t + 0.5, s.t + 0.8, "amber"]);
      } else if (s.verb === "record") {
        const k = String(s.args.key ?? [...flight.keys()][0] ?? "");
        const from = flight.get(k);
        if (from !== undefined) erings.push([from, s.t, "green"]);
        flight.delete(k);
        live.get(k)?.col.push([s.t + 0.3, "green"]);
      } else if (s.verb === "expire") {
        const k = String(s.args.key ?? [...live.keys()].at(-1) ?? "");
        const m = live.get(k);
        if (m) m.gone = s.t;
        live.delete(k);
      }
    }
    return MACHINE_PARTS["idempotency guard"].draw(t, {
      tl,
      rings,
      erings,
      fx,
    });
  },
  "inference step": (t, p) => {
    const stage = latest(
      p.steps.filter((s) => s.verb === "stage"),
      t
    );
    const stop =
      stage &&
      p.steps.find(
        (s) => s.t >= stage.t && ["finish", "fail"].includes(s.verb)
      );
    const from = stage ? stage.t + 0.65 : p.timeline.period + 1;
    const to = stop
      ? stop.t + (stop.verb === "finish" ? Number(stop.args.work ?? 0) : 0.3)
      : p.timeline.period;
    const span = Math.min(to - from, 1.5);
    return MACHINE_PARTS["inference step"].draw(t, {
      cl: [from, to],
      lights: stage
        ? Array.from({ length: 6 }, (_, i) => from + 0.1 + (span * i) / 6)
        : [],
    });
  },
  "structured step": (t, p) => {
    const ask = latest(
      p.steps.filter((s) => s.verb === "ask"),
      t
    );
    const n = Number(ask?.args.questions ?? 3);
    const checks = p.steps.filter(
      (s) => ask && s.verb === "validate" && s.t >= ask.t
    );
    const bad = checks.some((s) => s.args.outcome === "invalid");
    const lamps: LampStep[][] = [0, 1, 2].map((i) =>
      ask && i < n
        ? [
            [0, "off"],
            [ask.t + 0.85 + 0.35 * i, bad && i === n - 1 ? "amber" : "green"],
          ]
        : [[0, "off"]]
    );
    return MACHINE_PARTS["structured step"].draw(t, {
      wait: ask
        ? [ask.t + 0.6, ask.t + 0.85 + 0.35 * n]
        : [p.timeline.period + 1, p.timeline.period + 2],
      chk: checks.map(
        (s) => [s.t, s.args.outcome === "invalid" ? "red" : "green"] as const
      ),
      lamps,
    });
  },
  "execute step": (t, p) => {
    const run = latest(
      p.steps.filter((s) => s.verb === "transform" || s.verb === "fail"),
      t
    );
    const st = run ? run.t + 0.7 : p.timeline.period + 1;
    return MACHINE_PARTS["execute step"].draw(t, {
      st,
      crash: run?.verb === "fail" ? st + 0.15 : null,
    });
  },
  "route step": (t, p) => {
    const turn = latest(
      p.steps.filter((s) => ["route", "decide", "fail"].includes(s.verb)),
      t
    );
    const at = turn?.t ?? p.timeline.period + 1;
    const rule =
      turn && turn.verb !== "fail" ? String(turn.args.rule ?? "r1") : null;
    const lit = (from: number, to: number, yes: boolean) =>
      turn
        ? ([
            [from, "amber"],
            [to, yes ? "green" : "edge"],
          ] as const)
        : [];
    return MACHINE_PARTS["route step"].draw(t, {
      tiles: [
        { x: 236, label: "r1", col: lit(at + 0.5, at + 0.8, rule === "r1") },
        {
          x: 300,
          label: "r2",
          col: rule === "r1" ? [] : lit(at + 0.8, at + 1.1, rule === "r2"),
        },
        {
          x: 364,
          label: rule === null ? "none" : "else",
          col:
            rule === "r1" || rule === "r2"
              ? []
              : turn
                ? [
                    [at + 1.1, "amber"],
                    [at + 1.4, rule === "else" ? "green" : "red"],
                  ]
                : [],
        },
      ],
      arm: [at + 1.15, rule === "r2" ? 1 : rule === "else" ? 2 : 0],
      labels: strings(p.props.targets),
    });
  },
  "wait children": (t, p) => {
    const steps = cycle(p.steps, t, ["spawn"], ["validate", "fail"]);
    const spawn = steps.find((s) => s.verb === "spawn");
    const from = spawn ? spawn.t + 0.7 : p.timeline.period + 1;
    const done: (number | null)[] = [null, null, null];
    for (const s of steps)
      if (s.verb === "wait" && s.args.outcome !== "running")
        done[Math.min(3, Math.max(1, Number(s.args.child ?? 1))) - 1] =
          s.t + 0.5;
    return MACHINE_PARTS["wait children"].draw(t, {
      rings: [255, 315, 375].map((x, i) => {
        const d = done[i];
        return d != null
          ? ([x, from, d, "green"] as const)
          : ([x, from, spawn ? p.timeline.period : from + 1, null] as const);
      }),
      chk: steps
        .filter((s) => s.verb === "validate")
        .map(
          (s) => [s.t, s.args.outcome === "rejected" ? "red" : "green"] as const
        ),
    });
  },
  "human gate": (t, p) => {
    const steps = cycle(p.steps, t, ["wait"], ["stop"]);
    const wait = steps.find((s) => s.verb === "wait");
    const end = steps.find(
      (s) =>
        s.verb === "stop" ||
        (s.verb === "validate" && s.args.outcome !== "invalid")
    );
    const from = wait ? wait.t + 0.6 : p.timeline.period + 1;
    return MACHINE_PARTS["human gate"].draw(t, {
      wait: [
        from,
        end
          ? end.t + (end.verb === "stop" ? 0.7 : 0.2)
          : wait
            ? p.timeline.period
            : from + 1,
      ],
    });
  },
  "run end": (t, p) => {
    const bar: [number, number][] = [[0, 0]];
    let ring: [number, number] | null = null;
    let lane = false;
    let done: number | null = null;
    for (const s of p.steps) {
      if (s.verb === "stop" && s.args.by !== "user") bar.push([s.t + 0.3, 1]);
      else if (s.verb === "stop") {
        ring = [s.t + 0.6, s.t + 1.5];
        lane = true;
      } else if (s.verb === "resume") bar.push([s.t, 0]);
      else if (s.verb === "finish") done = s.t + 0.9;
    }
    return MACHINE_PARTS["run end"].draw(t, {
      bar,
      done,
      ring,
      ringX: 300,
      lane: lane ? [330, 96, 140] : null,
    });
  },
  "task run": (t, p) => {
    const labs = strings(p.props.steps) ?? [];
    const lab = [0, 1, 2].map((i) => labs[i] ?? `step ${i + 1}`) as [
      string,
      string,
      string,
    ];
    const st: [number, number][] = [[0, 0]];
    const lamps: LampStep[][] = [[[0, "off"]], [[0, "off"]], [[0, "off"]]];
    let done: number | null = null;
    let cur = 0;
    let waiting = false;
    for (const s of p.steps) {
      if (s.verb === "start") {
        st.push([s.t, 0], [s.t + 0.8, 1]);
        lamps[0].push([s.t + 0.9, "amber"]);
        cur = 0;
        waiting = false;
      } else if (s.verb === "stage" && cur < 2) {
        lamps[cur].push([s.t, "green"]);
        if (waiting) st.push([s.t, 1]);
        cur++;
        if (!waiting && cur < 2) lamps[cur].push([s.t + 0.8, "amber"]);
        waiting = false;
      } else if (s.verb === "wait") {
        waiting = true;
        st.push([s.t, 2]);
        if (cur < 2) lamps[cur].push([s.t, "amber"]);
      } else if (s.verb === "finish") {
        st.push([s.t, 3]);
        done = s.t;
      } else if (s.verb === "fail") {
        st.push([s.t, 4]);
        lamps[Math.min(cur, 1)].push([s.t, "red"]);
      }
    }
    return MACHINE_PARTS["task run"].draw(t, {
      lab,
      st: st.sort((a, b) => a[0] - b[0]),
      lamps,
      done,
    });
  },
} satisfies Record<keyof typeof MACHINE_PARTS, Drawing>;

/** GUI extensions provide drawings independently of validation schemas. */
export const FlowDrawingsContext =
  createContext<Readonly<Record<string, Drawing>>>(FLOW_DRAWINGS);

export function useFlowDrawings(): Readonly<Record<string, Drawing>> {
  return useContext(FlowDrawingsContext);
}

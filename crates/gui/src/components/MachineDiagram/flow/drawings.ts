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
} satisfies Record<keyof typeof MACHINE_PARTS, Drawing>;

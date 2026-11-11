/**
 * upcaster · reads old events as new (catalogue "upcaster"): two upcast holes
 * (1 → 2, 2 → 3). Frame 300×160, footprint M; the stored event enters W, the
 * current version leaves E. Durations from the gallery "v1 → v2 → v3" story:
 * the event reaches a hole in 0.55 s, each upcast takes 0.45 s and the
 * current version leaves in 0.55 s.
 */
import type { PartKindDef } from "../registry";
import { Y, leg, sideGates } from "./common";

const ports = {
  in: {
    side: "W",
    x: 170,
    y: Y,
    direction: "in",
    tokens: ["event", "data"],
    description: "event (stored version)",
  },
  out: {
    side: "E",
    x: 470,
    y: Y,
    direction: "out",
    tokens: ["event", "data"],
    description: "event (current version)",
  },
} as const satisfies PartKindDef["ports"];

const tokens = ["event", "data"] as const;
/** Upcast holes: stored version → x. */
const HOLES = { 1: 260, 2: 380 } as const;

/** When each upcast hole is reached and runs, for an event stored at `from`. */
export function upcastPlan(from: number, t: number) {
  const stops: { v: 1 | 2; x: number; at: number; from: number; to: number }[] =
    [];
  let at = t;
  for (const v of [1, 2] as const) {
    if (v < from) continue;
    stops.push({ v, x: HOLES[v], at, from: at + 0.55, to: at + 1.0 });
    at += 1.1;
  }
  return { stops, end: at };
}

export const upcasterPart: PartKindDef<
  Record<string, unknown>,
  { upcast: number }
> = {
  kind: "upcaster",
  job: "reads old events as new",
  family: "event sourcing",
  footprint: "M",
  bb: [170, 120, 300, 160],
  status: { x: 320, y: 312 },
  ports,
  gates: () => sideGates(ports),
  init: () => ({ upcast: 0 }),
  verbs: {
    upcast: {
      duration: 2.8,
      card: "required",
      tokens,
      description:
        "an event stored at an older version passes each upcast hole and leaves as the current version (3)",
      args: { from: { type: "integer", min: 1, max: 3, default: 2 } },
      compile({ t, card, out, state, args }) {
        const from = Number(args.from);
        out.note(t, `read · stored as v${from}`, "ink");
        const { stops, end } = upcastPlan(from, t);
        const legs = [];
        const tags: [string, number, number][] = [
          [`v${from}`, t + 0.05, t + 0.4],
        ];
        let x = 170;
        for (const s of stops) {
          legs.push(
            leg(
              [
                [x, Y],
                [s.x, Y],
              ],
              s.at,
              0.5
            )
          );
          x = s.x;
          out.note(s.from, `upcast ${s.v} → ${s.v + 1}`, "amber");
          tags.push([`v${s.v + 1}`, s.to + 0.05, s.to + 0.4]);
          state.upcast++;
        }
        legs.push(
          leg(
            [
              [x, Y],
              [470, Y],
            ],
            end,
            0.5
          )
        );
        out.carry(legs, t, end + 0.55, {
          role: card!.role,
          lean: legs.slice(1).map((l) => l[1]),
          tags,
        });
        out.note(end + 0.1, "v3 to handler", "green");
        return {
          exit: "out",
          token: "event",
          role: "green",
          duration: end + 0.6 - t,
        };
      },
    },
    fail: {
      duration: 2.2,
      card: "required",
      tokens,
      description:
        "an event stored at a version no upcaster covers bounces back unread",
      args: { from: { type: "integer", min: 0, default: 0 } },
      compile({ t, card, out, args }) {
        const from = Number(args.from);
        out.note(t, `read · stored as v${from}`, "ink");
        out.carry(
          [
            leg(
              [
                [170, Y],
                [215, Y],
              ],
              t,
              0.55
            ),
            leg(
              [
                [215, Y],
                [170, Y],
              ],
              t + 0.75,
              0.75
            ),
          ],
          t,
          t + 1.6,
          {
            role: card!.role,
            col: [[t + 0.62, "red"]],
            lean: [t + 0.75],
            tags: [
              [`v${from}`, t + 0.05, t + 0.4],
              ["unknown", t + 0.9, t + 1.35],
            ],
          }
        );
        out.note(t + 0.65, `no upcaster for v${from}`, "red");
        return { role: "red", consumed: true };
      },
    },
  },
};

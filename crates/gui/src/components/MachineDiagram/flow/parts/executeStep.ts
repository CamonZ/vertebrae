/**
 * execute step · runs a Rhai script (catalogue "execute step"): a stamp on
 * the context card, with dashed host stubs up to tasks, artifacts and cmd.
 * Frame 260×120, footprint M; context in W, transformed data out E, host
 * calls N. Durations from the gallery "transforms" and "calls the host"
 * stories: the context seats in 0.6 s, the stamp comes down 0.7 s later and
 * the output leaves 0.2 s after that; a host call is out in 0.35 s and back
 * in 0.35 s.
 */
import { RAIL_Y as Y } from "../../partGeometry";
import { dot, card as makeCard } from "../../timeline";
import type { PartKindDef, VerbContext } from "../registry";
import { leg, sideGates } from "./common";

const ports = {
  in: {
    side: "W",
    x: 200,
    y: Y,
    direction: "in",
    tokens: ["payload", "data", "request"],
    description: "context",
  },
  out: {
    side: "E",
    x: 460,
    y: Y,
    direction: "out",
    tokens: ["data"],
    description: "transformed data",
  },
  host: {
    side: "N",
    x: 350,
    y: 140,
    direction: "both",
    tokens: ["signal"],
    dashed: true,
    description: "host functions: tasks, artifacts, cmd",
  },
} as const satisfies PartKindDef["ports"];

const HOST_X = { tasks: 250, artifacts: 350, cmd: 440 } as const;

type Ctx = VerbContext<Record<string, unknown>, Record<string, never>>;

/** The context seats under the stamp; returns the time the stamp lands. */
function seat(ctx: Ctx): number {
  const { t, card, out } = ctx;
  const st = t + 0.7;
  out.carry(
    [
      leg(
        [
          [200, Y],
          [330, Y],
        ],
        t,
        0.55
      ),
    ],
    t,
    st + 0.12,
    { role: card!.role, tags: [["context", t + 0.05, t + 0.4]] }
  );
  out.note(t, "context in", "ink");
  out.note(st, "running script", "dim");
  return st;
}

export const executeStepPart: PartKindDef<
  Record<string, unknown>,
  Record<string, never>
> = {
  kind: "execute step",
  job: "runs a Rhai script",
  family: "vertebrae workflows",
  footprint: "M",
  bb: [200, 140, 260, 120],
  status: { x: 330, y: 300 },
  ports,
  gates: () => sideGates(ports),
  init: () => ({}),
  verbs: {
    transform: {
      duration: 1.6,
      card: "required",
      tokens: ["payload", "data", "request"],
      description: "the script runs and the context leaves as valid output",
      compile(ctx) {
        const { out } = ctx;
        const st = seat(ctx);
        out.carry(
          [
            leg(
              [
                [330, Y],
                [460, Y],
              ],
              st + 0.2,
              0.5
            ),
          ],
          st + 0.12,
          st + 0.9,
          { role: "green", tags: [["json", st + 0.35, st + 0.85, -26]] }
        );
        out.note(st + 0.45, "output valid · step done", "green");
        return {
          exit: "out",
          role: "green" as const,
          token: "data" as const,
        };
      },
    },
    call: {
      duration: 0.9,
      card: "none",
      description: "the script calls a host function and gets the reply",
      args: {
        host: {
          type: "string",
          enum: ["tasks", "artifacts", "cmd"],
          default: "artifacts",
        },
        op: { type: "string", default: "read" },
      },
      compile({ t, out, args }) {
        const host = String(args.host) as keyof typeof HOST_X;
        const x = HOST_X[host];
        out.card(
          dot(
            [
              [x, 176],
              [x, 100],
            ],
            t,
            0.35,
            "amber"
          )
        );
        out.card(
          dot(
            [
              [x, 100],
              [x, 176],
            ],
            t + 0.45,
            0.35
          )
        );
        out.note(t, `vtb::${host} · ${String(args.op)}`, "amber");
      },
    },
    fail: {
      duration: 1.6,
      card: "required",
      tokens: ["payload", "data", "request"],
      description: "the script raises a runtime error and the step fails",
      compile(ctx) {
        const { out } = ctx;
        const st = seat(ctx);
        out.note(st + 0.15, "script error · step failed", "red");
        out.card(
          makeCard(
            36,
            "red",
            [
              leg(
                [
                  [330, Y],
                  [330, Y],
                ],
                st + 0.1,
                0.05
              ),
            ],
            st + 0.1,
            st + 1.4,
            { tags: [["runtime error", st + 0.3, st + 1.3, 32]] }
          )
        );
        return { consumed: true, role: "red" as const };
      },
    },
  },
};

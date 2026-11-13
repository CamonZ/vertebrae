/**
 * route step · picks the next step by rules (catalogue "route step"): rule
 * tiles r1, r2, else lit in order, then the arm swings to the chosen
 * transition. Frame 200×180, footprint S; payload in W, one transition out
 * per E port. Durations from the gallery "rule matches" story: the run seats
 * in 0.55 s, each rule is tried 0.3 s after the last, the arm swings 1.15 s
 * in and the run leaves 0.35 s later.
 */
import { RAIL_Y as Y } from "../../partGeometry";
import { gateV } from "../../timeline";
import type { PartKindDef, VerbContext } from "../registry";
import { leg, sideGates } from "./common";

const OUT_Y = { out1: 150, out2: Y, out3: 250 } as const;
const PIVOT = [300, Y] as const;

const ports = {
  in: {
    side: "W",
    x: 200,
    y: Y,
    direction: "in",
    tokens: ["payload", "request", "data"],
    description: "step output",
  },
  out1: {
    side: "E",
    x: 400,
    y: OUT_Y.out1,
    direction: "out",
    tokens: ["payload", "request", "data"],
    description: "transition for rule r1",
  },
  out2: {
    side: "E",
    x: 400,
    y: OUT_Y.out2,
    direction: "out",
    tokens: ["payload", "request", "data"],
    description: "transition for rule r2",
  },
  out3: {
    side: "E",
    x: 400,
    y: OUT_Y.out3,
    direction: "out",
    tokens: ["payload", "request", "data"],
    description: "default transition",
  },
} as const satisfies PartKindDef["ports"];

interface RouteProps {
  targets: readonly string[];
}

type Rule = "r1" | "r2" | "else";
const PORT_OF = { r1: "out1", r2: "out2", else: "out3" } as const;

type Ctx = VerbContext<RouteProps, Record<string, never>>;

const args = {
  rule: {
    type: "string",
    enum: ["r1", "r2", "else"],
    default: "r1",
    description: "which rule matches (else is the default transition)",
  },
} as const;

/** Try the rules in order, then swing the arm; returns the arm swing time. */
function evaluate(ctx: Ctx, rule: Rule | null): number {
  const { t, out, part } = ctx;
  const target = (i: number) => part.props.targets[i] ?? `out${i + 1}`;
  out.note(t, "evaluating rules", "dim");
  if (rule === "r1") out.note(t + 0.8, `r1 yes → ${target(0)}`, "ink");
  else {
    out.note(t + 0.8, "r1 no", "dim");
    if (rule === "r2") out.note(t + 1.1, `r2 yes → ${target(1)}`, "ink");
    else {
      out.note(t + 1.1, "r2 no", "dim");
      if (rule === "else") out.note(t + 1.4, `default → ${target(2)}`, "ink");
      else out.note(t + 1.4, "no rule · no default · step failed", "red");
    }
  }
  return t + 1.15;
}

function chosen(ctx: Ctx): Rule {
  return String(ctx.args.rule ?? "r1") as Rule;
}

export const routeStepPart: PartKindDef<RouteProps, Record<string, never>> = {
  kind: "route step",
  job: "picks the next step by rules",
  family: "vertebrae workflows",
  footprint: "S",
  bb: [200, 110, 200, 180],
  status: { x: 300, y: 322 },
  props: {
    targets: {
      type: "string[]",
      default: ["review", "docs", "plan"],
      description: "labels of the three transitions (r1, r2, default)",
    },
  },
  ports,
  gates: () => [
    ...sideGates({ in: ports.in }),
    ...Object.values(OUT_Y).map((y) => gateV(400, y)),
  ],
  init: () => ({}),
  verbs: {
    route: {
      duration: 1.9,
      card: "required",
      tokens: ["payload", "request", "data"],
      description:
        "the rules are tried in order and the run leaves by the transition that matches",
      args,
      compile(ctx) {
        const { t, card, out } = ctx;
        const rule = chosen(ctx);
        const to = PORT_OF[rule];
        const y = OUT_Y[to];
        const swing = evaluate(ctx, rule);
        out.carry(
          [
            leg([[200, Y], [...PIVOT]], t, 0.55),
            leg([[...PIVOT], [400, y]], swing + 0.35, 0.5),
          ],
          t,
          swing + 0.95,
          { role: card!.role, tags: [["run", t + 0.05, t + 0.4]] }
        );
        return { exit: to };
      },
    },
    decide: {
      duration: 1.5,
      card: "none",
      description:
        "the rules are tried and the arm swings, without a run in the step",
      args,
      compile(ctx) {
        evaluate(ctx, chosen(ctx));
      },
    },
    fail: {
      duration: 2.4,
      card: "required",
      tokens: ["payload", "request", "data"],
      description: "no rule matches and there is no default: the run goes back",
      compile(ctx) {
        const { t, card, out } = ctx;
        evaluate(ctx, null);
        out.carry(
          [
            leg([[200, Y], [...PIVOT]], t, 0.55),
            leg([[...PIVOT], [200, Y]], t + 1.8, 0.6),
          ],
          t,
          t + 2.5,
          {
            role: card!.role,
            col: [[t + 1.4, "red"]],
            lean: [t + 1.8],
            tags: [
              ["run", t + 0.05, t + 0.4],
              ["no transition", t + 1.95, t + 2.45],
            ],
          }
        );
        return { consumed: true, role: "red" as const };
      },
    },
  },
};

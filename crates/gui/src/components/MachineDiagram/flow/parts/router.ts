/**
 * router · picks one way out (catalogue "router"): a swinging arm over
 * three out rails and a dashed lane down (fallback or 404). Frame 190×180,
 * footprint S; in W, out E r1..r3, fallback S. Durations from the gallery
 * "routed" story: the card reaches the arm in 0.55 s, the arm swings and
 * the card leaves 0.7 s after arriving.
 */
import type { PartKindDef, VerbContext } from "../registry";
import { Y, leg } from "./common";
import { gateH, gateV } from "../../timeline";

const OUT = { r1: 140, r2: Y, r3: 260 } as const;
type RouteName = keyof typeof OUT;

const ports = {
  in: { side: "W", x: 200, y: Y, direction: "in", tokens: ["request"] },
  r1: { side: "E", x: 390, y: 140, direction: "out", tokens: ["request"] },
  r2: { side: "E", x: 390, y: Y, direction: "out", tokens: ["request"] },
  r3: { side: "E", x: 390, y: 260, direction: "out", tokens: ["request"] },
  fallback: {
    side: "S",
    x: 270,
    y: 290,
    direction: "out",
    tokens: ["request", "result"],
    dashed: true,
    description: "no match: fallback, or 404 when there is none",
  },
} as const satisfies PartKindDef["ports"];

interface RouterProps {
  /** Labels of r1, r2, r3 (path prefixes, tool names, regions). */
  routes: readonly string[];
  /** Unmatched cards go to the fallback port instead of failing. */
  fallback: boolean;
}

type Ctx = VerbContext<RouterProps, { routed: number }>;

function swing(ctx: Ctx, to: RouteName | "fallback" | null) {
  const { t, card, out, part, state } = ctx;
  const arm = t + 0.55;
  const pivot = [270, Y] as const;
  state.routed++;
  out.note(t, "match path", "dim");
  if (to === null) {
    out.carry(
      [leg([[200, Y], pivot], t, 0.5), leg([pivot, [270, 290]], arm, 0.4)],
      t,
      arm + 0.45,
      { role: card!.role, col: [[arm, "red"]] }
    );
    out.note(arm, "no route · 404", "red");
    return { role: "red" as const, exit: "fallback" };
  }
  const end =
    to === "fallback" ? ([270, 290] as const) : ([390, OUT[to]] as const);
  out.carry(
    [leg([[200, Y], pivot], t, 0.5), leg([pivot, end], arm, 0.4)],
    t,
    arm + 0.45,
    { role: card!.role }
  );
  if (to === "fallback") out.note(arm, "no match → fallback", "amber");
  else {
    const i = Number(to.slice(1)) - 1;
    out.note(arm, `→ ${part.props.routes[i] ?? to}`, "ink");
  }
  return { exit: to };
}

export const routerPart: PartKindDef<RouterProps, { routed: number }> = {
  kind: "router",
  job: "picks one way out",
  family: "compute",
  footprint: "S",
  bb: [200, 110, 190, 180],
  status: { x: 480, y: 322 },
  props: {
    routes: {
      type: "string[]",
      default: ["/tasks", "/runs", "/health"],
      description: "labels of the r1, r2 and r3 rails",
    },
    fallback: {
      type: "boolean",
      default: false,
      description: "unmatched cards take the fallback port instead of failing",
    },
  },
  ports,
  gates: () => [
    gateV(200, Y),
    gateV(390, 140),
    gateV(390, Y),
    gateV(390, 260),
    gateH(270, 290),
  ],
  init: () => ({ routed: 0 }),
  verbs: {
    route: {
      duration: 1.0,
      card: "required",
      tokens: ["request"],
      description: "match the card label (or `path`) against `routes`",
      args: {
        path: { type: "string", description: "defaults to the card label" },
      },
      compile(ctx) {
        const path = String(ctx.args.path ?? ctx.card!.label);
        const i = ctx.part.props.routes.findIndex((r) => path.startsWith(r));
        if (i >= 0 && i < 3) return swing(ctx, `r${i + 1}` as RouteName);
        return swing(ctx, ctx.part.props.fallback ? "fallback" : null);
      },
    },
    decide: {
      duration: 1.0,
      card: "required",
      tokens: ["request"],
      description: "send the card to a named way out",
      args: {
        to: {
          type: "string",
          enum: ["r1", "r2", "r3", "fallback", "none"],
          required: true,
        },
      },
      compile(ctx) {
        const to = String(ctx.args.to);
        return swing(
          ctx,
          to === "none" ? null : (to as RouteName | "fallback")
        );
      },
    },
    fail: {
      duration: 0.6,
      card: "none",
      args: { reason: { type: "string", default: "no route · 404" } },
      compile({ t, out, args }) {
        out.note(t, String(args.reason), "red");
      },
    },
  },
};

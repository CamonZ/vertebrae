/**
 * approval · waits for a person (catalogue "approval"): a gate held by a
 * person rail from above. Frame 220×120, footprint M; in W, out E
 * (approved), ctl N (the person). Durations from the gallery "approved"
 * story: the request seats in 0.6 s, the person answers 0.8 s later and the
 * gate lifts for 0.6 s.
 */
import { card as makeCard } from "../../timeline";
import { HELD, type PartKindDef } from "../registry";
import { leg } from "./common";
import { gateH, gateV } from "../../timeline";

const Y = 210;
const SLOT = [300, Y] as const;

const ports = {
  in: { side: "W", x: 200, y: Y, direction: "in", tokens: ["request"] },
  out: {
    side: "E",
    x: 420,
    y: Y,
    direction: "out",
    tokens: ["request"],
    description: "request (approved)",
  },
  person: {
    side: "N",
    x: 310,
    y: 150,
    direction: "in",
    tokens: ["control"],
    description: "person rail (approve, reject)",
  },
} as const satisfies PartKindDef["ports"];

interface ApprovalState {
  held: string | null;
  /** Drawing marks: waiting from, the gate lift, the deadline ring. */
  waitFrom: number | null;
  end: number | null;
  lift: number | null;
  failed: boolean;
  expired: boolean;
}

function person(t: number, yes: boolean) {
  return makeCard(
    18,
    "ink",
    [
      leg(
        [
          [520, 96],
          [310, 96],
          [310, 200],
        ],
        t,
        0.8
      ),
    ],
    t,
    t + 0.85,
    { tags: [[yes ? "yes" : "no", t + 0.05, t + 0.5]] }
  );
}

export const approvalPart: PartKindDef<
  Record<string, unknown>,
  ApprovalState
> = {
  kind: "approval",
  job: "waits for a person",
  family: "policy",
  footprint: "M",
  bb: [200, 150, 220, 120],
  status: { x: 310, y: 302 },
  ports,
  gates: () => [gateV(200, Y), gateV(420, Y), gateH(310, 150)],
  init: () => ({
    held: null,
    waitFrom: null,
    end: null,
    lift: null,
    failed: false,
    expired: false,
  }),
  verbs: {
    wait: {
      duration: 1.2,
      card: "required",
      tokens: ["request"],
      description: "the request arrives and waits for a person",
      compile({ t, card, out, state }) {
        out.carry([leg([[200, Y], SLOT], t, 0.6)], t, HELD, {
          role: card!.role,
        });
        state.held = card!.id;
        state.waitFrom = t + 0.6;
        state.end = null;
        state.lift = null;
        state.failed = false;
        state.expired = false;
        out.note(t, `${card!.label} arrives`, "ink");
        out.note(t + 0.6, "waiting for a person", "amber");
        return { duration: 1.2 };
      },
    },
    approve: {
      duration: 1.2,
      card: "required",
      tokens: ["request"],
      description: "the person says yes: the gate lifts and the request leaves",
      compile({ t, out, state }) {
        out.card(person(t, true));
        const at = t + 0.85;
        if (state.held) out.end(state.held, at);
        state.held = null;
        state.end = at;
        state.lift = at;
        out.carry(
          [leg([SLOT, [420, Y]], at + 0.05, 0.6)],
          at + 0.05,
          at + 0.7,
          {
            role: "ink",
            col: [[at, "green"]],
            lean: [at + 0.05],
          }
        );
        out.note(at, "approved", "green");
        return { exit: "out", role: "green" as const, duration: 1.7 };
      },
    },
    reject: {
      duration: 1.2,
      card: "required",
      tokens: ["request"],
      description: "the person says no: the request goes back",
      compile({ t, out, state }) {
        out.card(person(t, false));
        const at = t + 0.85;
        if (state.held) out.end(state.held, at);
        state.held = null;
        state.end = at;
        state.failed = true;
        out.carry([leg([SLOT, [24, Y]], at + 0.05, 0.6)], at + 0.05, at + 0.7, {
          role: "ink",
          col: [[at, "red"]],
          lean: [at + 0.05],
          tags: [["rejected", at + 0.15, at + 0.65]],
        });
        out.note(at, "rejected", "red");
        return { consumed: true, role: "red" as const, duration: 1.7 };
      },
    },
    expire: {
      duration: 1,
      card: "required",
      tokens: ["request"],
      description: "nobody answers before the deadline",
      compile({ t, out, state }) {
        if (state.held) out.end(state.held, t + 0.1);
        state.held = null;
        state.end = t;
        state.failed = true;
        state.expired = true;
        out.carry([leg([SLOT, [24, Y]], t + 0.1, 0.6)], t + 0.1, t + 0.75, {
          role: "ink",
          col: [[t, "red"]],
          lean: [t + 0.1],
          tags: [["expired", t + 0.25, t + 0.7]],
        });
        out.note(t, "no answer · expired", "red");
        return { consumed: true, role: "red" as const };
      },
    },
  },
};

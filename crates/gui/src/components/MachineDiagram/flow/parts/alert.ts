/**
 * alert · gets someone's attention (catalogue "alert"; the gallery's
 * Beacon): a lamp with bursts and an escalation lane. Frame 140×100,
 * footprint S; event in W, out E (acknowledged), escalation E (dashed).
 * Durations from the gallery "acknowledged" story: the event reaches the
 * lamp in 0.5 s, the page leaves 0.3 s after it fires.
 */
import { gateV } from "../../timeline";
import type { PartKindDef } from "../registry";
import { Y, leg } from "./common";

const ports = {
  in: {
    side: "W",
    x: 220,
    y: Y,
    direction: "in",
    tokens: ["event", "signal", "request"],
  },
  out: {
    side: "E",
    x: 360,
    y: Y,
    direction: "out",
    tokens: ["result", "request"],
    description: "result (acknowledged)",
  },
  escalate: {
    side: "E",
    x: 360,
    y: 236,
    direction: "out",
    tokens: ["request", "event"],
    dashed: true,
    description: "escalation",
  },
} as const satisfies PartKindDef["ports"];

interface AlertState {
  fire: number | null;
  ack: number | null;
  escalated: boolean;
}

export const alertPart: PartKindDef<Record<string, unknown>, AlertState> = {
  kind: "alert",
  job: "gets someone's attention",
  family: "observability",
  footprint: "S",
  bb: [220, 150, 140, 100],
  status: { x: 290, y: 282 },
  ports,
  gates: () => [gateV(220, Y), gateV(360, Y)],
  init: () => ({ fire: null, ack: null, escalated: false }),
  verbs: {
    notify: {
      duration: 1.1,
      card: "optional",
      tokens: ["event", "signal", "request"],
      description: "the event fires the lamp and pages someone",
      compile({ t, card, out, state }) {
        if (card)
          out.carry(
            [
              leg(
                [
                  [220, Y],
                  [236, Y],
                ],
                t,
                0.5
              ),
            ],
            t,
            t + 0.52,
            { role: card.role, h: 8 }
          );
        state.fire = t + 0.6;
        state.ack = null;
        state.escalated = false;
        out.note(t + 0.6, "firing", "amber");
        out.note(t + 1.6, "paged · waiting for ack", "amber");
        return { consumed: true, duration: 1.7 };
      },
    },
    acknowledge: {
      duration: 0.8,
      card: "none",
      description: "someone acknowledges: the lamp stops",
      compile({ t, out, state }) {
        state.ack = t;
        out.note(t, "acknowledged", "green");
      },
    },
    escalate: {
      duration: 0.8,
      card: "none",
      description: "nobody answered: escalate",
      compile({ t, out, state }) {
        state.escalated = true;
        out.note(t, "no ack · escalating", "red");
      },
    },
  },
};

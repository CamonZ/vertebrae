/**
 * boundary · crossing costs a hop (catalogue "boundary"): a dashed region
 * with packets crossing its edge to the handler inside; a partition cuts the
 * edge. Frame 340×250, footprint L; in W at the edge, out E at the handler.
 * Durations from the gallery "crosses" story: three packets cross in 0.4 s,
 * 0.08 s apart, and the call reassembles inside 0.65 s after the edge.
 */
import { card as makeCard, gateV } from "../../timeline";
import type { PartKindDef } from "../registry";
import { Y, leg } from "./common";

const ports = {
  in: {
    side: "W",
    x: 230,
    y: Y,
    direction: "in",
    tokens: ["request", "payload", "data"],
  },
  out: {
    side: "E",
    x: 540,
    y: Y,
    direction: "out",
    tokens: ["request", "payload", "data"],
    description: "inside: the call delivered to the handler",
  },
} as const satisfies PartKindDef["ports"];

interface BoundaryProps {
  /** Region name drawn in the corner, e.g. SACRUM PROCESS. */
  region?: string;
}

export const boundaryPart: PartKindDef<BoundaryProps, { hops: number }> = {
  kind: "boundary",
  job: "crossing costs a hop",
  family: "topology and lifecycle",
  footprint: "L",
  bb: [230, 80, 340, 250],
  status: { x: 400, y: 356 },
  props: {
    region: {
      type: "string",
      description: "region name, e.g. a process or network",
    },
  },
  ports,
  gates: () => [gateV(230, Y)],
  init: () => ({ hops: 0 }),
  verbs: {
    cross: {
      duration: 1.2,
      card: "required",
      description: "serialize the card across the edge (one hop)",
      args: {
        outcome: {
          type: "string",
          enum: ["ok", "refused", "partition"],
          default: "ok",
        },
        reason: { type: "string", default: "untrusted" },
      },
      compile({ t, card, out, state, args }) {
        const outcome = String(args.outcome);
        if (outcome === "refused") {
          out.carry(
            [
              leg(
                [
                  [230, Y],
                  [230, Y],
                ],
                t,
                0.05
              ),
            ],
            t,
            t + 0.5,
            {
              role: "red",
              lean: [t + 0.15],
              tags: [[String(args.reason), t + 0.1, t + 0.5]],
            }
          );
          out.note(t, "refused at the edge", "red");
          return { role: "red" as const, consumed: true, duration: 0.8 };
        }
        state.hops++;
        const lost = outcome === "partition";
        for (let i = 0; i < 3; i++) {
          const a = t + 0.08 * i;
          out.card(
            makeCard(
              12,
              "ink",
              [
                leg(
                  [
                    [230, Y],
                    [330, Y],
                  ],
                  a,
                  0.4
                ),
              ],
              a,
              lost ? a + 0.16 : a + 0.5,
              { h: 8, ...(lost ? { col: [[a + 0.1, "red"] as const] } : {}) }
            )
          );
        }
        out.note(t, "serialize · cross", "amber");
        if (lost) {
          out.note(t + 0.3, "hop lost", "red");
          return { role: "red" as const, consumed: true, duration: 0.9 };
        }
        out.carry(
          [
            leg(
              [
                [330, Y],
                [540, Y],
              ],
              t + 0.7,
              0.45
            ),
          ],
          t + 0.65,
          t + 1.2,
          { role: card!.role }
        );
        out.note(t + 0.75, "inside", "ink");
        return { exit: "out" };
      },
    },
    spawn: {
      duration: 0.5,
      card: "none",
      compile({ t, out }) {
        out.note(t, "instance up", "ink");
      },
    },
    close: {
      duration: 0.5,
      card: "none",
      compile({ t, out }) {
        out.note(t, "instance down", "dim");
      },
    },
    fail: {
      duration: 0.8,
      card: "none",
      args: { reason: { type: "string", default: "caller gets no reply" } },
      compile({ t, out, args }) {
        out.note(t, String(args.reason), "amber");
      },
    },
  },
};

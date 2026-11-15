/**
 * A logical graph connector, not a process/trust boundary or a runtime step.
 * Its neutral drawing has no observed status, gates, network region or hop.
 * A story may explicitly transfer a card through it without changing the card.
 */
import type { PartKindDef } from "../registry";
import { leg, Y } from "./common";
import { transitionTokens } from "./topology";

const ports = {
  in: { side: "W", x: 280, y: Y, direction: "in", tokens: transitionTokens },
  out: { side: "E", x: 360, y: Y, direction: "out", tokens: transitionTokens },
} as const satisfies PartKindDef["ports"];

export const topologyEndpointPart: PartKindDef = {
  kind: "topology endpoint",
  job: "logical graph endpoint; no runtime origin implied",
  family: "workflow topology",
  footprint: "S",
  bb: [280, 180, 80, 40],
  status: { x: 320, y: 260 },
  neutral: true,
  ports,
  verbs: {
    transfer: {
      duration: 0.3,
      card: "required",
      tokens: transitionTokens,
      description:
        "pass a card through the logical endpoint without processing or conversion",
      compile({ t, card, out }) {
        out.carry(
          [
            leg(
              [
                [280, Y],
                [360, Y],
              ],
              t,
              0.3
            ),
          ],
          t,
          t + 0.3,
          { role: card!.role }
        );
        return { exit: "out" };
      },
    },
  },
};

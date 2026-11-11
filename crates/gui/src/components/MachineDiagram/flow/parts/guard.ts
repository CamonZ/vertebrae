/**
 * guard · allows or denies (catalogue "guard"): a check hole between in and
 * out; a deny drops to the dashed lane below. Frame 200×150, footprint S.
 * Durations from the gallery "allow · deny" story: the ring fills for 0.6 s
 * after the card seats, then the card leaves allow E or deny S.
 */
import type { PartKindDef } from "../registry";
import { Y, centred, sideGates } from "./common";

const ports = {
  in: { side: "W", x: 220, y: Y, direction: "in", tokens: ["request"] },
  allow: { side: "E", x: 420, y: Y, direction: "out", tokens: ["request"] },
  deny: {
    side: "S",
    x: 320,
    y: 275,
    direction: "out",
    tokens: ["result", "request"],
    dashed: true,
  },
} as const satisfies PartKindDef["ports"];

interface GuardProps {
  /** Subjects (tool names, operations) the guard allows; everything else is denied. */
  allow: readonly string[];
  /** Why a deny happens, shown as `deny · <reason>`. */
  reason: string;
}

export const guardPart: PartKindDef<GuardProps, { decisions: number }> = {
  kind: "guard",
  job: "allows or denies",
  family: "policy",
  footprint: "S",
  bb: centred(200, 150),
  status: { x: 320, y: 318 },
  props: {
    allow: { type: "string[]", default: [] },
    reason: { type: "string", default: "not allowed" },
  },
  ports,
  gates: () => sideGates(ports),
  init: () => ({ decisions: 0 }),
  verbs: {
    decide: {
      duration: 1.4,
      card: "required",
      tokens: ["request"],
      args: {
        subject: { type: "string", description: "defaults to the card label" },
        outcome: {
          type: "string",
          enum: ["allow", "deny"],
          description: "force the outcome instead of checking `allow`",
        },
      },
      compile({ t, card, out, part, args, state }) {
        const subject = String(args.subject ?? card!.label);
        const allowed =
          args.outcome !== undefined
            ? args.outcome === "allow"
            : part.props.allow.includes(subject);
        state.decisions++;
        const decided = t + 0.85;
        const role = allowed ? "green" : "red";
        out.carry(
          [
            [
              [
                [220, Y],
                [320, Y],
              ],
              t,
              0.4,
            ],
            allowed
              ? [
                  [
                    [320, Y],
                    [420, Y],
                  ],
                  decided,
                  0.4,
                ]
              : [
                  [
                    [320, Y],
                    [320, 275],
                  ],
                  decided,
                  0.4,
                ],
          ],
          t,
          decided + 0.5,
          { role: card!.role, col: [[decided, role]], lean: [decided] }
        );
        out.note(t + 0.4, `${subject} · deciding`, "amber");
        out.note(
          decided,
          allowed ? "allow" : `deny · ${part.props.reason}`,
          role
        );
        return { role, exit: allowed ? "allow" : "deny" };
      },
    },
    validate: {
      duration: 1.2,
      card: "required",
      compile({ t, card, out }) {
        out.carry(
          [
            [
              [
                [220, Y],
                [420, Y],
              ],
              t,
              0.8,
            ],
          ],
          t,
          t + 0.9,
          {
            role: card!.role,
            col: [[t + 0.6, "green"]],
          }
        );
        out.note(t, "validating", "amber");
        out.note(t + 0.6, "valid", "green");
        return { role: "green", exit: "allow" };
      },
    },
    fail: {
      duration: 0.8,
      card: "none",
      args: { reason: { type: "string", default: "policy gap" } },
      compile({ t, out, args }) {
        out.note(t, `failed · ${String(args.reason)}`, "red");
      },
    },
  },
};

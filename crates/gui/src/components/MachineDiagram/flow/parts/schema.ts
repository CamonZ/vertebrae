/**
 * schema · checks the shape (catalogue "schema"): a check box between the
 * in and out rails; misfits stop at it. Frame 220×160, footprint M; data in
 * W, valid data out E. Durations from the gallery "fits" story: the card
 * seats in 0.6 s and crosses the check 0.95 s after it arrives.
 */
import type { PartKindDef } from "../registry";
import { Y, leg, sideGates } from "./common";

const ports = {
  in: {
    side: "W",
    x: 210,
    y: Y,
    direction: "in",
    tokens: ["data", "payload", "request"],
  },
  out: {
    side: "E",
    x: 430,
    y: Y,
    direction: "out",
    tokens: ["data", "payload"],
    description: "valid data; invalid data stops at the check",
  },
} as const satisfies PartKindDef["ports"];

interface SchemaProps {
  /** The shape the check enforces, shown under the check box. */
  shape: string;
}

const failed = (args: Readonly<Record<string, unknown>>) =>
  `rejected · ${String(args.reason)}`;

export const schemaPart: PartKindDef<SchemaProps> = {
  kind: "schema",
  job: "checks the shape",
  family: "data and state",
  footprint: "M",
  bb: [210, 120, 220, 160],
  status: { x: 320, y: 312 },
  props: { shape: { type: "string", default: "{id, name}" } },
  ports,
  gates: () => sideGates(ports),
  verbs: {
    validate: {
      duration: 1.6,
      card: "required",
      tokens: ["data", "payload", "request"],
      description:
        "check a value: a fit crosses, a misfit stops at the check and goes back, an old version is upgraded and then fits",
      args: {
        outcome: {
          type: "string",
          enum: ["ok", "invalid", "migrated"],
          default: "ok",
        },
        reason: { type: "string", default: "missing id" },
      },
      compile({ t, card, out, args }) {
        const { outcome } = args;
        out.note(t, "checking", "dim");
        if (outcome === "invalid") {
          out.carry(
            [
              leg(
                [
                  [210, Y],
                  [300, Y],
                ],
                t,
                0.6
              ),
              leg(
                [
                  [300, Y],
                  [210, Y],
                ],
                t + 1.45,
                0.6
              ),
            ],
            t,
            t + 2.1,
            {
              role: card!.role,
              col: [[t + 1.33, "red"]],
              lean: [t + 1.45],
              tags: [
                [card!.label, t + 0.05, t + 0.4],
                [String(args.reason), t + 1.6, t + 2.05],
              ],
            }
          );
          out.note(t + 1.2, failed(args), "red");
          return { duration: 2.1, role: "red", consumed: true };
        }
        const migrate = outcome === "migrated";
        out.carry(
          [
            leg(
              [
                [210, Y],
                [320, Y],
              ],
              t,
              0.6
            ),
            leg(
              [
                [320, Y],
                [430, Y],
              ],
              t + (migrate ? 1.15 : 0.95),
              0.6
            ),
          ],
          t,
          t + (migrate ? 1.85 : 1.6),
          {
            role: card!.role,
            col: migrate
              ? [
                  [t + 0.4, "amber"],
                  [t + 1.03, "green"],
                ]
              : [[t + 0.83, "green"]],
            lean: migrate ? [t + 1.15] : [],
            tags: [
              [card!.label, t + 0.05, t + 0.4],
              [migrate ? "upgraded" : "valid", t + 1.1, t + 1.55],
            ],
          }
        );
        if (migrate) {
          out.note(t + 0.4, "v1 · upgrading", "amber");
          out.note(t + 1.0, "migrated · fits", "green");
        } else out.note(t + 0.7, "fits", "green");
        return { exit: "out", role: "green" as const };
      },
    },
    decide: {
      duration: 0.8,
      card: "none",
      description: "the check's verdict on its own, without moving a card",
      args: {
        outcome: { type: "string", enum: ["ok", "invalid"], default: "ok" },
        reason: { type: "string", default: "missing id" },
      },
      compile({ t, out, args }) {
        out.note(t, "checking", "dim");
        if (args.outcome === "invalid") out.note(t + 0.5, failed(args), "red");
        else out.note(t + 0.5, "fits", "green");
      },
    },
    fail: {
      duration: 0.6,
      card: "none",
      description: "the check itself cannot run",
      args: { reason: { type: "string", default: "schema unavailable" } },
      compile({ t, out, args }) {
        out.note(t, `failed · ${String(args.reason)}`, "red");
      },
    },
  },
};

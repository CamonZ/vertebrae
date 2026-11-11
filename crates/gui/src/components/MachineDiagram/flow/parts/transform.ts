/**
 * transform · changes the shape (catalogue "transform"): die and stamp.
 * Frame 240×160, footprint M; in W, out E (the same card, new shape).
 * Durations from the gallery "Task out" story: the card seats under the
 * stamp, the stamp drops for 0.25 s, the new shape leaves 0.2 s later.
 */
import type { PartKindDef } from "../registry";
import { Y, leg, sideGates } from "./common";

const ports = {
  in: {
    side: "W",
    x: 200,
    y: Y,
    direction: "in",
    tokens: ["data", "payload", "request"],
  },
  out: { side: "E", x: 440, y: Y, direction: "out", tokens: ["data"] },
} as const satisfies PartKindDef["ports"];

export const transformPart: PartKindDef = {
  kind: "transform",
  job: "changes the shape",
  family: "compute",
  footprint: "M",
  bb: [200, 120, 240, 160],
  status: { x: 320, y: 312 },
  ports,
  gates: () => sideGates(ports),
  verbs: {
    transform: {
      duration: 1.0,
      card: "required",
      tokens: ["data", "payload", "request"],
      description: "stamp the card into a new shape; it leaves as data",
      args: {
        to: { type: "string", description: "the new shape, e.g. Task" },
        outcome: { type: "string", enum: ["ok", "error"], default: "ok" },
        reason: { type: "string", default: "bad field" },
      },
      compile({ t, card, out, args }) {
        const ok = args.outcome !== "error";
        const to = String(args.to ?? "data");
        const stamped = t + 0.65;
        out.carry(
          [
            leg(
              [
                [200, Y],
                [296, Y],
              ],
              t,
              0.4
            ),
            leg(
              [
                [296, Y],
                [440, Y],
              ],
              stamped,
              0.35
            ),
          ],
          t,
          stamped + 0.4,
          {
            role: card!.role,
            col: [[stamped, ok ? "ink" : "red"]],
            tags: [
              [card!.label, t + 0.02, t + 0.4],
              [ok ? to : "parse error", stamped, stamped + 0.4],
            ],
          }
        );
        out.note(t, `${card!.label} in`, "ink");
        out.note(t + 0.4, "stamping", "dim");
        out.note(
          stamped,
          ok ? `${to} out` : `failed · ${String(args.reason)}`,
          ok ? "green" : "red"
        );
        return ok
          ? { exit: "out", token: "data" as const, role: "ink" as const }
          : { role: "red" as const, consumed: true };
      },
    },
    fail: {
      duration: 0.6,
      card: "none",
      args: { reason: { type: "string", default: "bad field" } },
      compile({ t, out, args }) {
        out.note(t, `failed · ${String(args.reason)}`, "red");
      },
    },
  },
};

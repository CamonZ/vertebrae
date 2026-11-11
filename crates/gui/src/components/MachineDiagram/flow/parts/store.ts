/**
 * store · keeps records (catalogue "store"): a bar stack. Frame 180×230,
 * footprint M; data in W, a read leaves E. Durations from the gallery
 * "insert · read" story: an insert springs in over 0.65 s, a read leaves
 * 0.6 s after it starts.
 */
import type { PartKindDef } from "../registry";
import { Y, leg, sideGates } from "./common";

const ports = {
  in: {
    side: "W",
    x: 230,
    y: Y,
    direction: "in",
    tokens: ["data", "request", "payload"],
  },
  out: {
    side: "E",
    x: 410,
    y: Y,
    direction: "out",
    tokens: ["data", "result"],
  },
} as const satisfies PartKindDef["ports"];

interface StoreProps {
  /** Rows already stored (drawn as resident bars, at most 8). */
  rows: number;
}

interface StoreState {
  rows: number;
}

export const storePart: PartKindDef<StoreProps, StoreState> = {
  kind: "store",
  job: "keeps records",
  family: "data and state",
  footprint: "M",
  bb: [230, 88, 180, 230],
  status: { x: 320, y: 346 },
  props: { rows: { type: "integer", min: 0, max: 8, default: 4 } },
  ports,
  gates: () => sideGates(ports),
  init: (p) => ({ rows: p.rows }),
  verbs: {
    record: {
      duration: 0.7,
      card: "required",
      description:
        "insert a record; a duplicate key is rejected and bounces back",
      args: {
        outcome: { type: "string", enum: ["ok", "conflict"], default: "ok" },
      },
      compile({ t, card, out, state, args }) {
        const ok = args.outcome !== "conflict";
        out.note(t, "insert", "ink");
        if (ok) {
          state.rows++;
          out.carry(
            [
              leg(
                [
                  [230, Y],
                  [300, Y],
                ],
                t,
                0.6
              ),
            ],
            t,
            t + 0.65,
            { role: card!.role, tags: [["insert", t + 0.05, t + 0.4]] }
          );
          out.note(t + 0.7, `${state.rows} rows`, "dim");
          return { consumed: true };
        }
        out.carry(
          [
            leg(
              [
                [230, Y],
                [250, Y],
              ],
              t,
              0.45
            ),
            leg(
              [
                [250, Y],
                [230, Y],
              ],
              t + 0.7,
              0.5
            ),
          ],
          t,
          t + 1.3,
          {
            role: card!.role,
            col: [[t + 0.58, "red"]],
            lean: [t + 0.7],
            tags: [
              ["insert", t + 0.05, t + 0.4],
              ["conflict", t + 0.85, t + 1.3],
            ],
          }
        );
        out.note(t + 0.65, "rejected · unique key", "red");
        return { duration: 1.3, role: "red", consumed: true };
      },
    },
    read: {
      duration: 0.9,
      card: "optional",
      description:
        "read a row: it leaves as data, or the read finds nothing and stops",
      args: {
        row: { type: "string", default: "row 2" },
        outcome: { type: "string", enum: ["ok", "missing"], default: "ok" },
      },
      compile({ t, card, out, args }) {
        const ok = args.outcome !== "missing";
        const row = String(args.row);
        out.note(t, `read · ${row}`, "ink");
        if (card)
          out.carry(
            [
              leg(
                [
                  [330, Y],
                  [410, Y],
                ],
                t + 0.05,
                0.6
              ),
            ],
            t + 0.05,
            t + 0.75,
            {
              role: ok ? "ink" : "red",
              tags: [[ok ? row : `${row} · not found`, t + 0.2, t + 0.7]],
            }
          );
        if (!ok) out.note(t + 0.5, "not found", "red");
        if (!card) return;
        return ok
          ? { exit: "out", token: "data" as const, role: "ink" as const }
          : { role: "red" as const, consumed: true };
      },
    },
    delete: {
      duration: 0.6,
      card: "none",
      description: "remove a record",
      compile({ t, out, state }) {
        state.rows = Math.max(0, state.rows - 1);
        out.note(t, `deleted · ${state.rows} rows`, "amber");
      },
    },
    snapshot: {
      duration: 0.6,
      card: "none",
      description: "note the rows as they are now",
      compile({ t, out, state }) {
        out.marker({ t, kind: "checkpoint", label: `${state.rows} rows` });
        out.note(t, `snapshot · ${state.rows} rows`, "ink");
      },
    },
  },
};

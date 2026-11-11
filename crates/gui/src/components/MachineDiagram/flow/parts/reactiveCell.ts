/**
 * reactive cell · tells readers it changed (catalogue "reactive cell"): a
 * cell with one reader rail per reader. Frame 130×100, footprint S; a write
 * enters W, a change notice leaves E on the reader rails (out1 upper, out2
 * lower). Durations from the gallery "readers updated" story: the write
 * seats in 0.6 s, the change reaches a reader 0.8 s after the write starts.
 */
import type { PartKindDef } from "../registry";
import { Y, leg, sideGates } from "./common";

const ports = {
  in: {
    side: "W",
    x: 220,
    y: Y,
    direction: "in",
    tokens: ["data", "request", "payload"],
    description: "a write",
  },
  out1: {
    side: "E",
    x: 350,
    y: 175,
    direction: "out",
    tokens: ["control", "signal"],
    description: "change notice to the first reader",
  },
  out2: {
    side: "E",
    x: 350,
    y: 225,
    direction: "out",
    tokens: ["control", "signal"],
    description: "change notice to the second reader",
  },
} as const satisfies PartKindDef["ports"];

interface CellProps {
  /** The value the cell starts with. */
  value: string;
}

interface CellState {
  value: string;
  /** The last write changed the value, so readers are owed a notice. */
  changed: boolean;
}

/** From the cell to each reader port; the reader rails take over from there. */
const lane = {
  out1: [
    [285, Y],
    [350, 175],
  ],
  out2: [
    [285, Y],
    [350, 225],
  ],
} as const;

export const reactiveCellPart: PartKindDef<CellProps, CellState> = {
  kind: "reactive cell",
  job: "tells readers it changed",
  family: "data and state",
  footprint: "S",
  bb: [220, 150, 130, 100],
  status: { x: 285, y: 282 },
  props: { value: { type: "string", default: "3" } },
  ports,
  gates: () => sideGates(ports),
  init: (p) => ({ value: p.value, changed: false }),
  verbs: {
    record: {
      duration: 0.8,
      card: "required",
      description:
        "a write sets the value; writing the same value changes nothing and stays quiet",
      args: { value: { type: "string", default: "4" } },
      compile({ t, card, out, state, args }) {
        const next = String(args.value);
        state.changed = next !== state.value;
        out.carry(
          [
            leg(
              [
                [220, Y],
                [285, Y],
              ],
              t,
              0.6
            ),
          ],
          t,
          t + 0.65,
          { role: card!.role, tags: [[`set ${next}`, t + 0.05, t + 0.4]] }
        );
        if (state.changed) {
          state.value = next;
          out.note(t + 0.7, "changed → 2 readers", "ink");
        } else out.note(t + 0.7, "same value · quiet", "dim");
        return { consumed: true };
      },
    },
    notify: {
      duration: 0.8,
      card: "optional",
      tokens: ["control", "signal"],
      description: "send the change notice to one reader (out1 or out2)",
      args: {
        reader: { type: "string", enum: ["out1", "out2"], default: "out1" },
        outcome: { type: "string", enum: ["ok", "error"], default: "ok" },
      },
      compile({ t, card, out, state, args }) {
        const reader = args.reader === "out2" ? "out2" : "out1";
        const ok = args.outcome !== "error";
        if (!state.changed) {
          out.note(t, "same value · quiet", "dim");
          return { consumed: Boolean(card) };
        }
        if (card)
          out.carry([leg(lane[reader], t, 0.45)], t, t + 0.5, {
            role: ok ? "ink" : "red",
          });
        out.note(
          t + 0.65,
          ok ? "readers updated" : "1 reader failed",
          ok ? "green" : "red"
        );
        return card ? { exit: reader, role: ok ? "ink" : "red" } : undefined;
      },
    },
    observe: {
      duration: 0.6,
      card: "none",
      description: "a reader looks at the current value",
      compile({ t, out, state }) {
        out.note(t, `value · ${state.value}`, "ink");
      },
    },
  },
};

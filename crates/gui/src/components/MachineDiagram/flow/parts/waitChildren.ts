/**
 * wait children · parks for child tasks (catalogue "wait children"): the
 * parent slot forks to one ring per child task, then a check on the combined
 * output. Frame 270×180, footprint M; parent in W, combined output out E.
 * Durations from the gallery "all children done" story: the parent seats in
 * 0.55 s, the fork dots fly 0.3 s, a ring fills while its child runs, the
 * parent crosses to the check in 0.4 s and leaves in 0.3 s.
 */
import { card as makeCard, dot } from "../../timeline";
import { HELD, type PartKindDef } from "../registry";
import { leg, sideGates } from "./common";

const WY = 235;
const M = [315, WY] as const;
const CHILD_X = [255, 315, 375] as const;

const ports = {
  in: {
    side: "W",
    x: 180,
    y: WY,
    direction: "in",
    tokens: ["payload", "request", "data"],
    description: "parent run",
  },
  out: {
    side: "E",
    x: 450,
    y: WY,
    direction: "out",
    tokens: ["payload", "data"],
    description: "combined output of the children",
  },
} as const satisfies PartKindDef["ports"];

interface WaitState {
  /** The parent card parked in the slot (or at the check). */
  held: string | null;
  /** When the child rings start. */
  forked: number;
  /** Per child: when it finished, or null while it runs. */
  done: (number | null)[];
  checked: boolean;
}

const finished = (s: WaitState) => s.done.filter((d) => d != null).length;

export const waitChildrenPart: PartKindDef<
  Record<string, unknown>,
  WaitState
> = {
  kind: "wait children",
  job: "parks for child tasks",
  family: "vertebrae workflows",
  footprint: "M",
  bb: [180, 110, 270, 180],
  status: { x: 315, y: 322 },
  ports,
  gates: () => sideGates(ports),
  init: () => ({
    held: null,
    forked: 0,
    done: [null, null, null],
    checked: false,
  }),
  verbs: {
    spawn: {
      duration: 1.0,
      card: "required",
      tokens: ["payload", "request", "data"],
      description:
        "the parent parks in the slot and one child task is forked per ring",
      compile({ t, card, out, state }) {
        out.carry([leg([[180, WY], [...M]], t, 0.55)], t, HELD, {
          role: card!.role,
          tags: [["run", t + 0.05, t + 0.4]],
        });
        state.held = card!.id;
        state.forked = t + 0.7;
        state.done = [null, null, null];
        state.checked = false;
        out.note(t, "run arrives", "ink");
        out.note(t + 0.45, "3 children forked", "dim");
        for (const x of CHILD_X)
          out.card(
            dot(
              [
                [315, 212],
                [x, 170],
              ],
              t + 0.45,
              0.3,
              "amber",
              { dies: t + 0.8 }
            )
          );
      },
    },
    wait: {
      duration: 0.7,
      card: "none",
      description:
        "a child task finishes, or the run keeps waiting for one that has not",
      args: {
        child: { type: "integer", min: 1, max: 3, default: 1 },
        outcome: { type: "string", enum: ["done", "running"], default: "done" },
      },
      compile({ t, out, state, args }) {
        const i = Math.min(3, Math.max(1, Number(args.child ?? 1))) - 1;
        if (args.outcome === "running") {
          out.note(t, `${finished(state)} of 3 · run waiting`, "amber");
          return;
        }
        state.done[i] = t + 0.5;
        const n = finished(state);
        out.note(t + 0.5, `${n} of 3 done`, n === 3 ? "ink" : "amber");
      },
    },
    join: {
      duration: 0.7,
      card: "none",
      description:
        "every child is done: the parent crosses to the check on the combined output",
      compile({ t, out, state }) {
        if (state.held) {
          out.end(state.held, t);
          out.card(
            makeCard(36, "ink", [leg([[...M], [400, WY]], t, 0.4)], t, HELD, {
              id: state.held,
            })
          );
        }
      },
    },
    validate: {
      duration: 0.9,
      card: "optional",
      description: "the combined output is checked against the step's schema",
      args: {
        outcome: { type: "string", enum: ["ok", "rejected"], default: "ok" },
      },
      compile({ t, card, out, state, args }) {
        state.checked = true;
        if (state.held) out.end(state.held, t + 0.1);
        state.held = null;
        if (args.outcome === "rejected") {
          out.note(t, "combined output rejected · step failed", "red");
          return { role: "red" as const, consumed: true };
        }
        out.note(t, "combined output fits · step done", "green");
        if (card)
          out.carry(
            [
              leg(
                [
                  [400, WY],
                  [450, WY],
                ],
                t + 0.1,
                0.35
              ),
            ],
            t + 0.1,
            t + 0.55,
            { role: "green", tags: [["results", t + 0.15, t + 0.55]] }
          );
        return { exit: "out", role: "green" as const };
      },
    },
    fail: {
      duration: 0.8,
      card: "none",
      description: "a child returns no verdict and the step fails",
      args: { reason: { type: "string", default: "child failed" } },
      compile({ t, out, state, args }) {
        if (state.held) out.end(state.held, t + 0.4);
        state.held = null;
        out.note(t, `${String(args.reason)} · step failed`, "red");
      },
    },
  },
};

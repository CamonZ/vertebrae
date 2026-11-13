/**
 * structured step · asks typed questions (catalogue "structured step"): an
 * answer hole with one lamp per question, then a schema check frame. Frame
 * 280×180, footprint M; context in W, typed answer out E. Durations from the
 * gallery "answered" story: the state seats in 0.6 s, a lamp lights every
 * 0.35 s, the schema check flashes for 0.6 s.
 */
import { RAIL_Y as Y } from "../../partGeometry";
import { HELD, type PartKindDef } from "../registry";
import { leg, sideGates } from "./common";

const ports = {
  in: {
    side: "W",
    x: 180,
    y: Y,
    direction: "in",
    tokens: ["payload", "data", "request"],
    description: "state and questions (context)",
  },
  out: {
    side: "E",
    x: 460,
    y: Y,
    direction: "out",
    tokens: ["data"],
    description: "typed answer",
  },
} as const satisfies PartKindDef["ports"];

interface StructuredState {
  held: string | null;
  questions: number;
  checked: boolean;
}

interface StructuredProps {
  provider: string;
}

export const structuredStepPart: PartKindDef<StructuredProps, StructuredState> =
  {
    kind: "structured step",
    job: "asks typed questions",
    family: "vertebrae workflows",
    footprint: "M",
    bb: [180, 110, 280, 180],
    status: { x: 320, y: 322 },
    props: {
      provider: {
        type: "string",
        default: "typesafe",
        description: "who answers the questions",
      },
    },
    ports,
    gates: () => sideGates(ports),
    init: () => ({ held: null, questions: 3, checked: false }),
    verbs: {
      ask: {
        duration: 2.0,
        card: "required",
        tokens: ["payload", "data", "request"],
        description:
          "the state and questions seat in the answer hole; each answer lights a lamp",
        args: {
          questions: { type: "integer", min: 1, max: 3, default: 3 },
        },
        compile({ t, card, out, state, part, args }) {
          const n = Number(args.questions ?? 3);
          out.carry(
            [
              leg(
                [
                  [180, Y],
                  [270, Y],
                ],
                t,
                0.6
              ),
            ],
            t,
            HELD,
            {
              role: card!.role,
              tags: [[`state + ${n} qs`, t + 0.05, t + 0.45]],
            }
          );
          state.held = card!.id;
          state.questions = n;
          state.checked = false;
          out.note(t, "state + questions in", "ink");
          out.note(t + 0.6, `asking · ${part.props.provider}`, "dim");
          for (let i = 1; i <= n; i++)
            out.note(
              t + 0.85 + 0.35 * (i - 1),
              `${i} of ${n} answered`,
              i === n ? "ink" : "amber"
            );
          return { duration: 0.85 + 0.35 * n + 0.2 };
        },
      },
      validate: {
        duration: 0.7,
        card: "none",
        description: "the typed answer is checked against its schema",
        args: {
          outcome: { type: "string", enum: ["ok", "invalid"], default: "ok" },
          question: { type: "integer", min: 1, max: 3, default: 3 },
        },
        compile({ t, out, state, args }) {
          state.checked = true;
          if (args.outcome === "invalid")
            out.note(
              t,
              `q${Number(args.question ?? state.questions)} not in its enum · step failed`,
              "red"
            );
          else out.note(t, "answers fit · step done", "green");
        },
      },
      finish: {
        duration: 1.0,
        card: "optional",
        description: "the answer passes the check and leaves as data",
        compile({ t, card, out, state }) {
          if (state.held) out.end(state.held, t + 0.4);
          state.held = null;
          if (card)
            out.carry(
              [
                leg(
                  [
                    [270, Y],
                    [402, Y],
                  ],
                  t,
                  0.4
                ),
                leg(
                  [
                    [402, Y],
                    [460, Y],
                  ],
                  t + 0.45,
                  0.3
                ),
              ],
              t,
              t + 0.85,
              { role: "green", tags: [["answers", t + 0.5, t + 0.85]] }
            );
          if (!state.checked)
            out.note(t + 0.4, "answers fit · step done", "green");
          state.checked = false;
          return {
            exit: "out",
            role: "green" as const,
            ...(card ? { token: "data" as const } : {}),
          };
        },
      },
      fail: {
        duration: 0.8,
        card: "none",
        description: "an answer is rejected and the step fails",
        args: { reason: { type: "string", default: "answer rejected" } },
        compile({ t, out, state, args }) {
          if (state.held) out.end(state.held, t + 0.4);
          state.held = null;
          if (!state.checked)
            out.note(t, `${String(args.reason)} · step failed`, "red");
          state.checked = false;
        },
      },
    },
  };

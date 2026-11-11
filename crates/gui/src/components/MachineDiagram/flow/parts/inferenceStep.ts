/**
 * inference step · one agent turn (catalogue "inference step"): the press,
 * plus a tools box the agent calls out to while clamped. Frame 240×190,
 * footprint M; context in W, output out E, tool calls N. Durations from the
 * gallery "done" and "tool calls" stories: the prompt seats in 0.6 s, each
 * tool call is out in 0.35 s and back in 0.3 s, the output leaves in 0.6 s.
 */
import { RAIL_Y as Y } from "../../MachinePart";
import { dot } from "../../timeline";
import { HELD, type PartKindDef } from "../registry";
import { sideGates } from "./common";

const ports = {
  in: {
    side: "W",
    x: 200,
    y: Y,
    direction: "in",
    tokens: ["payload", "data", "request"],
    description: "prompt (context)",
  },
  out: {
    side: "E",
    x: 440,
    y: Y,
    direction: "out",
    tokens: ["result"],
    description: "output",
  },
  tools: {
    side: "N",
    x: 380,
    y: 105,
    direction: "both",
    tokens: ["signal"],
    dashed: true,
    description: "tool calls to the tools box",
  },
} as const satisfies PartKindDef["ports"];

interface InferenceState {
  /** Id of the prompt card clamped in the press. */
  clamped: string | null;
  /** The output was already checked against the schema. */
  checked: boolean;
}

interface InferenceProps {
  harness: string;
}

export const inferenceStepPart: PartKindDef<InferenceProps, InferenceState> = {
  kind: "inference step",
  job: "one agent turn",
  family: "vertebrae workflows",
  footprint: "M",
  bb: [200, 105, 240, 190],
  status: { x: 320, y: 328 },
  props: {
    harness: {
      type: "string",
      default: "claude",
      description: "the harness running the turn (claude, codex, mistral vibe)",
    },
  },
  ports,
  gates: () => sideGates(ports),
  init: () => ({ clamped: null, checked: false }),
  verbs: {
    stage: {
      duration: 0.75,
      card: "required",
      tokens: ["payload", "data", "request"],
      description: "the prompt seats in the press and the agent starts",
      compile({ t, card, out, state, part }) {
        out.carry(
          [
            [
              [
                [200, Y],
                [320, Y],
              ],
              t,
              0.5,
            ],
          ],
          t,
          HELD,
          { role: card!.role, tags: [["prompt", t + 0.05, t + 0.4]] }
        );
        state.clamped = card!.id;
        state.checked = false;
        out.note(t, `prompt in · ${part.props.harness}`, "ink");
        out.note(t + 0.75, "agent working", "dim");
      },
    },
    call: {
      duration: 0.8,
      card: "none",
      description:
        "the agent calls a tool in the tools box and gets the result",
      args: {
        tool: {
          type: "string",
          enum: ["read", "edit", "test"],
          default: "read",
        },
      },
      compile({ t, out, args }) {
        const tool = String(args.tool);
        out.card(
          dot(
            [
              [380, 150],
              [380, 88],
              [474, 88],
            ],
            t,
            0.35,
            "amber",
            { tags: [[tool, t + 0.05, t + 0.5, -20]] }
          )
        );
        out.card(
          dot(
            [
              [474, 88],
              [380, 88],
              [380, 150],
            ],
            t + 0.4,
            0.3,
            "ink"
          )
        );
        out.note(t, `tool call · ${tool}`, "amber");
      },
    },
    validate: {
      duration: 0.3,
      card: "none",
      description: "the output is checked against the step's schema",
      args: {
        outcome: { type: "string", enum: ["ok", "invalid"], default: "ok" },
      },
      compile({ t, out, state, args }) {
        state.checked = true;
        if (args.outcome === "invalid")
          out.note(t, "output fails schema · step failed", "red");
        else out.note(t, "done · output fits schema", "green");
      },
    },
    finish: {
      duration: 0.7,
      card: "optional",
      args: { work: { type: "number", min: 0, default: 0 } },
      description: "the turn ends and the output leaves as a result",
      compile({ t, card, out, state, args }) {
        const at = t + Number(args.work ?? 0);
        if (state.clamped) out.end(state.clamped, at);
        state.clamped = null;
        if (card)
          out.carry(
            [
              [
                [
                  [320, Y],
                  [440, Y],
                ],
                at,
                0.4,
              ],
            ],
            at,
            at + 0.5,
            { role: "green", tags: [["output", at + 0.1, at + 0.55]] }
          );
        if (!state.checked) out.note(at, "done · output fits schema", "green");
        state.checked = false;
        return {
          duration: at - t + 0.7,
          role: "green",
          exit: "out",
          ...(card ? { token: "result" as const } : {}),
        };
      },
    },
    fail: {
      duration: 0.7,
      card: "none",
      description: "the turn fails: the output does not fit the schema",
      args: { reason: { type: "string", default: "output fails schema" } },
      compile({ t, out, state, args }) {
        if (state.clamped) out.end(state.clamped, t + 0.3);
        state.clamped = null;
        if (!state.checked)
          out.note(t, `${String(args.reason)} · step failed`, "red");
        state.checked = false;
      },
    },
  },
};

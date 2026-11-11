/**
 * human gate · parks for a person's answer (catalogue "human gate"): a
 * parked slot with a waiting spinner; the answer artifact drops in from the
 * reviewer lane. Frame 220×120, footprint M; question in W, answer out E,
 * reviewer lane NE. Durations from the gallery "answered" story: the run
 * seats in 0.6 s, the answer artifact drops in 0.8 s, the answer is checked
 * 0.8 s later and the run leaves in 0.6 s.
 */
import { card as makeCard, gateH, gateV } from "../../timeline";
import { HELD, type PartKindDef } from "../registry";
import { leg } from "./common";

const Y = 210;
const SLOT = [300, Y] as const;

const ports = {
  in: {
    side: "W",
    x: 200,
    y: Y,
    direction: "in",
    tokens: ["payload", "request", "data"],
    description: "question",
  },
  out: {
    side: "E",
    x: 420,
    y: Y,
    direction: "out",
    tokens: ["payload", "request", "data"],
    description: "run resumes with the answer",
  },
  reviewer: {
    side: "N",
    x: 400,
    y: 150,
    direction: "in",
    tokens: ["data", "control"],
    dashed: true,
    description: "reviewer lane (answer, stop)",
  },
} as const satisfies PartKindDef["ports"];

interface GateState {
  held: string | null;
  /** The attached answer fits the schema (decides how `validate` ends). */
  fits: boolean;
}

export const humanGatePart: PartKindDef<Record<string, unknown>, GateState> = {
  kind: "human gate",
  job: "parks for a person's answer",
  family: "vertebrae workflows",
  footprint: "M",
  bb: [200, 150, 220, 120],
  status: { x: 310, y: 302 },
  ports,
  gates: () => [gateV(200, Y), gateV(420, Y), gateH(400, 150)],
  init: () => ({ held: null, fits: true }),
  verbs: {
    wait: {
      duration: 1.2,
      card: "required",
      tokens: ["payload", "request", "data"],
      description: "the run parks in the gate and waits for a reviewer",
      compile({ t, card, out, state }) {
        out.carry([leg([[200, Y], [...SLOT]], t, 0.6)], t, HELD, {
          role: card!.role,
          tags: [["run", t + 0.05, t + 0.4]],
        });
        state.held = card!.id;
        out.note(t, "run arrives", "ink");
        out.note(t + 0.6, "waiting · reviewer", "amber");
      },
    },
    answer: {
      duration: 0.9,
      card: "none",
      description:
        "the reviewer sets the answer and the answer artifact drops in",
      args: {
        fits: {
          type: "boolean",
          default: true,
          description: "the answer fits the gate's schema",
        },
      },
      compile({ t, out, state, args }) {
        const fits = args.fits !== false;
        state.fits = fits;
        out.card(
          makeCard(
            24,
            "ink",
            [
              leg(
                [
                  [600, 96],
                  [400, 96],
                  [400, 176],
                ],
                t,
                0.8
              ),
              ...(fits
                ? []
                : [
                    leg(
                      [
                        [400, 176],
                        [400, 96],
                        [480, 96],
                      ],
                      t + 1.2,
                      0.7
                    ),
                  ]),
            ],
            t,
            fits ? t + 1.05 : t + 1.95,
            {
              h: 32,
              col: [[t + 0.8, fits ? "green" : "red"]],
              lean: fits ? [] : [t + 1.2],
              tags: [
                ["answer.md", t + 0.05, t + 0.55],
                ...(fits
                  ? []
                  : ([["missing decision", t + 1.5, t + 1.9]] as const)),
              ],
            }
          )
        );
        out.note(t, "answer.md attached", "ink");
      },
    },
    validate: {
      duration: 1.0,
      card: "optional",
      description:
        "the answer is checked: a fit resumes the run, a miss keeps the gate open",
      args: {
        outcome: {
          type: "string",
          enum: ["ok", "invalid"],
          description: "defaults to what the attached answer implies",
        },
      },
      compile({ t, card, out, state, args }) {
        const ok = (args.outcome ?? (state.fits ? "ok" : "invalid")) === "ok";
        if (!ok) {
          out.note(t, "answer fails schema · gate still open", "red");
          out.note(t + 1.2, "waiting · reviewer", "amber");
          return { duration: 1.4 };
        }
        if (state.held) out.end(state.held, t + 0.2);
        state.held = null;
        out.note(t, "answer fits · run resumes", "green");
        if (card)
          out.carry(
            [leg([[...SLOT], [420, Y]], t + 0.2, 0.6)],
            t + 0.2,
            t + 0.85,
            { role: "green", tags: [["run", t + 0.25, t + 0.7]] }
          );
        return { exit: "out", role: "green" as const };
      },
    },
    stop: {
      duration: 1.0,
      card: "none",
      description: "stop-taskrun arrives while the gate waits: the gate closes",
      compile({ t, out, state }) {
        out.card(
          makeCard(
            28,
            "ink",
            [
              leg(
                [
                  [24, Y],
                  [140, Y],
                ],
                t,
                0.6
              ),
            ],
            t,
            t + 1.0,
            { hollow: true, tags: [["stop", t + 0.05, t + 0.5]] }
          )
        );
        if (state.held) out.end(state.held, t + 0.8);
        state.held = null;
        out.note(t, "stop-taskrun · stopping", "amber");
        out.note(t + 0.7, "stopped · gate closed", "dim");
      },
    },
  },
};

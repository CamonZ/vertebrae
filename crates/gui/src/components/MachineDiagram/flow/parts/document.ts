/**
 * document · edited in place (catalogue "document"): a folded page. Frame
 * 180×240, footprint M; an edit enters W. Durations from the gallery "patch
 * applies" story: the patch seats in 0.65 s and the line is replaced 0.65 s
 * after it arrives.
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
    description: "an edit (patch)",
  },
} as const satisfies PartKindDef["ports"];

interface DocumentProps {
  /** Line the patch targets in the status text. */
  line: number;
}

interface DocumentState {
  version: number;
}

export const documentPart: PartKindDef<DocumentProps, DocumentState> = {
  kind: "document",
  job: "edited in place",
  family: "data and state",
  footprint: "M",
  bb: [230, 82, 180, 240],
  status: { x: 320, y: 350 },
  props: { line: { type: "integer", min: 1, max: 10, default: 5 } },
  ports,
  gates: () => sideGates(ports),
  init: () => ({ version: 1 }),
  verbs: {
    read: {
      duration: 0.6,
      card: "none",
      description: "read the document as it is now",
      compile({ t, out, state }) {
        out.note(t, `read · v${state.version}`, "ink");
      },
    },
    record: {
      duration: 1.3,
      card: "required",
      description:
        "a patch edits a line in place; when the line has moved it does not apply and bounces back",
      args: {
        outcome: { type: "string", enum: ["ok", "conflict"], default: "ok" },
      },
      compile({ t, card, out, state, part, args }) {
        const ok = args.outcome !== "conflict";
        const line = part.props.line;
        out.note(t, `patch line ${line}`, "ink");
        if (ok) {
          out.carry(
            [
              leg(
                [
                  [230, Y],
                  [290, Y],
                ],
                t,
                0.6
              ),
            ],
            t,
            t + 0.7,
            { role: card!.role, tags: [["patch", t + 0.05, t + 0.4]] }
          );
          state.version++;
          out.note(t + 0.7, `line ${line} replaced`, "green");
          return { consumed: true };
        }
        out.carry(
          [
            leg(
              [
                [230, Y],
                [256, Y],
              ],
              t,
              0.5
            ),
            leg(
              [
                [256, Y],
                [230, Y],
              ],
              t + 0.75,
              0.6
            ),
          ],
          t,
          t + 1.4,
          {
            role: card!.role,
            col: [[t + 0.63, "red"]],
            lean: [t + 0.75],
            tags: [
              ["patch", t + 0.05, t + 0.4],
              ["does not apply", t + 0.9, t + 1.35],
            ],
          }
        );
        out.note(t + 0.7, "conflict · line moved", "red");
        return { duration: 1.4, role: "red", consumed: true };
      },
    },
    version: {
      duration: 0.6,
      card: "none",
      description: "mark the current content as a version",
      compile({ t, out, state }) {
        out.marker({ t, kind: "checkpoint", label: `v${state.version}` });
        out.note(t, `version ${state.version}`, "ink");
      },
    },
  },
};

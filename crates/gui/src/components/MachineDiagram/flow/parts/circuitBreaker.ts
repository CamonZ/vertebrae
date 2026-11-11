/**
 * circuit breaker · fails fast when broken (catalogue "circuit breaker"):
 * blade and contacts; an open blade fails fast. Frame 250×130, footprint M;
 * in W, out E (closed only). Durations from the gallery "recovers" story: a
 * call crosses in 1.0 s, a fail-fast bounce takes 0.9 s, the cool-down lasts
 * 1.3 s before one half-open trial.
 */
import type { PartKindDef } from "../registry";
import { Y, leg, sideGates } from "./common";

const ports = {
  in: { side: "W", x: 180, y: Y, direction: "in", tokens: ["request"] },
  out: {
    side: "E",
    x: 430,
    y: Y,
    direction: "out",
    tokens: ["request"],
    description: "request (closed only)",
  },
} as const satisfies PartKindDef["ports"];

interface BreakerProps {
  /** Consecutive failures that open the blade. */
  threshold: number;
}

interface BreakerState {
  mode: "closed" | "open" | "half-open";
  failures: number;
  /** Drawing marks: failure times, open window, half-open window, cool-down. */
  fails: number[];
  open: [number, number | null] | null;
  half: [number, number | null] | null;
  cool: [number, number] | null;
  trial: number | null;
}

export const circuitBreakerPart: PartKindDef<BreakerProps, BreakerState> = {
  kind: "circuit breaker",
  job: "fails fast when broken",
  family: "messaging and flow control",
  footprint: "M",
  bb: [180, 135, 250, 130],
  status: { x: 305, y: 296 },
  props: { threshold: { type: "integer", min: 1, max: 3, default: 3 } },
  ports,
  gates: () => sideGates(ports),
  init: () => ({
    mode: "closed",
    failures: 0,
    fails: [],
    open: null,
    half: null,
    cool: null,
    trial: null,
  }),
  verbs: {
    send: {
      duration: 1,
      card: "required",
      tokens: ["request"],
      description: "closed: the call goes through; open: it fails fast",
      compile({ t, card, out, state }) {
        if (state.mode === "open") {
          out.carry(
            [
              leg(
                [
                  [180, Y],
                  [262, Y],
                ],
                t,
                0.5
              ),
              leg(
                [
                  [262, Y],
                  [180, Y],
                ],
                t + 0.6,
                0.5
              ),
            ],
            t,
            t + 1.15,
            {
              role: card!.role,
              col: [[t + 0.48, "red"]],
              lean: [t + 0.6],
              tags: [["fail fast", t + 0.7, t + 1.1]],
            }
          );
          out.note(t + 0.6, "open · fail fast", "red");
          return { consumed: true, role: "red" as const };
        }
        out.carry(
          [
            leg(
              [
                [180, Y],
                [430, Y],
              ],
              t,
              0.9
            ),
          ],
          t,
          t + 0.95,
          { role: card!.role }
        );
        out.note(
          t,
          state.mode === "closed" ? "closed" : "half-open · one trial",
          "dim"
        );
        return { exit: "out" };
      },
    },
    fail: {
      duration: 0.8,
      card: "none",
      description:
        "a call failed: counts toward the threshold; a failed trial reopens",
      compile({ t, out, state, part }) {
        if (state.mode === "half-open") {
          state.mode = "open";
          state.trial = t;
          if (state.half) state.half = [state.half[0], t];
          if (state.open) state.open = [state.open[0], null];
          out.note(t, "trial failed · open", "red");
          return;
        }
        state.failures++;
        state.fails.push(t);
        if (state.failures >= part.props.threshold) {
          state.mode = "open";
          state.open = [t + 0.1, null];
          out.note(t, `${state.failures} failures · open`, "red");
        } else
          out.note(
            t,
            `${state.failures} failure${state.failures > 1 ? "s" : ""}`,
            "red"
          );
      },
    },
    trip: {
      duration: 0.6,
      card: "none",
      description: "force the blade open and start the cool-down",
      compile({ t, out, state }) {
        state.mode = "open";
        state.open = [t, null];
        state.cool = [t + 0.2, t + 1.5];
        out.note(t, "open · fail fast", "red");
        out.note(t + 0.2, "cooling down", "amber");
        return { duration: 1.5 };
      },
    },
    probe: {
      duration: 1,
      card: "optional",
      tokens: ["request"],
      description: "half-open: one trial call goes through",
      compile({ t, card, out, state }) {
        state.mode = "half-open";
        state.half = [t, null];
        out.note(t, "half-open · one trial", "amber");
        if (card)
          out.carry(
            [
              leg(
                [
                  [180, Y],
                  [430, Y],
                ],
                t + 0.2,
                0.9
              ),
            ],
            t + 0.2,
            t + 1.15,
            { role: card.role, tags: [["trial", t + 0.25, t + 0.7]] }
          );
        return card ? { exit: "out", duration: 1.2 } : {};
      },
    },
    reset: {
      duration: 0.6,
      card: "none",
      description: "the trial succeeded: the blade closes",
      compile({ t, out, state }) {
        state.mode = "closed";
        state.failures = 0;
        state.trial = t;
        if (state.half) state.half = [state.half[0], t];
        if (state.open) state.open = [state.open[0], t];
        out.note(t, "trial ok · closed", "green");
      },
    },
  },
};

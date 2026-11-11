/**
 * cache · answers from memory (catalogue "cache"): a scan line over cached
 * entries and an origin box behind it. Frame 200×180, footprint S; requests
 * in W (upper), answers out W (lower); the origin rail leaves E (upper) and
 * the filled entry returns E (lower). Durations from the gallery "miss then
 * hit" story: a lookup scans for 0.45 s, a miss reaches the origin 1.05 s
 * after it starts, a hit turns back down 1.05 s after it starts.
 */
import type { PartKindDef } from "../registry";
import { leg, sideGates } from "./common";

const ports = {
  in: {
    side: "W",
    x: 180,
    y: 160,
    direction: "in",
    tokens: ["request", "data"],
  },
  answer: {
    side: "W",
    x: 180,
    y: 250,
    direction: "out",
    tokens: ["data", "result"],
    description: "a hit, or a miss filled from the origin",
  },
  origin: {
    side: "E",
    x: 380,
    y: 160,
    direction: "out",
    tokens: ["request"],
    description: "a miss goes on to the origin",
  },
  fill: {
    side: "E",
    x: 380,
    y: 250,
    direction: "in",
    tokens: ["data", "result"],
    description: "the origin's answer fills the cache",
  },
} as const satisfies PartKindDef["ports"];

interface CacheState {
  /** Cached keys. */
  keys: string[];
}

const key = (args: Readonly<Record<string, unknown>>) => String(args.key);
const keyArg = { key: { type: "string", default: "k2" } } as const;

const lookup = [
  [180, 160],
  [280, 160],
] as const;
const hit = [
  [280, 160],
  [280, 250],
  [180, 250],
] as const;
const miss = [
  [280, 160],
  [380, 160],
] as const;

export const cachePart: PartKindDef<Record<string, never>, CacheState> = {
  kind: "cache",
  job: "answers from memory",
  family: "data and state",
  footprint: "S",
  bb: [180, 110, 200, 180],
  status: { x: 280, y: 322 },
  ports,
  gates: () => sideGates(ports),
  init: () => ({ keys: ["k2"] }),
  verbs: {
    read: {
      duration: 1.7,
      card: "required",
      description:
        "look the key up: a cached key answers from memory (a hit), any other goes on to the origin",
      args: keyArg,
      compile({ t, card, out, state, args }) {
        const k = key(args);
        const found = state.keys.includes(k);
        out.note(t, "lookup", "dim");
        if (found) {
          out.carry([leg(lookup, t, 0.5), leg(hit, t + 0.9, 0.7)], t, t + 1.7, {
            role: card!.role,
            col: [[t + 0.8, "green"]],
            tags: [
              [`get ${k}`, t + 0.05, t + 0.4],
              ["hit", t + 1.1, t + 1.6, 28],
            ],
          });
          out.note(t + 0.8, "hit", "green");
          return {
            exit: "answer",
            role: "green" as const,
            token: "data" as const,
          };
        }
        out.carry([leg(lookup, t, 0.5), leg(miss, t + 0.9, 0.55)], t, t + 1.5, {
          role: card!.role,
          tags: [
            [`get ${k}`, t + 0.05, t + 0.4],
            ["miss", t + 1.0, t + 1.45],
          ],
        });
        out.note(t + 0.85, "miss → origin", "amber");
        return { exit: "origin", role: "amber" as const };
      },
    },
    miss: {
      duration: 1.5,
      card: "required",
      description:
        "a lookup that is known to miss (a stale or invalidated key): straight to the origin",
      args: keyArg,
      compile({ t, card, out, state, args }) {
        const k = key(args);
        state.keys = state.keys.filter((x) => x !== k);
        out.note(t, "lookup", "dim");
        out.carry([leg(lookup, t, 0.5), leg(miss, t + 0.9, 0.55)], t, t + 1.5, {
          role: card!.role,
          tags: [
            [`get ${k}`, t + 0.05, t + 0.4],
            ["miss", t + 1.0, t + 1.45],
          ],
        });
        out.note(t + 0.85, "miss → origin", "amber");
        return { exit: "origin", role: "amber" as const };
      },
    },
    record: {
      duration: 1.2,
      card: "required",
      tokens: ["data", "result"],
      description:
        "the origin's answer fills an entry and goes back to the caller",
      args: {
        ...keyArg,
        outcome: { type: "string", enum: ["ok", "error"], default: "ok" },
      },
      compile({ t, card, out, state, args }) {
        const ok = args.outcome !== "error";
        const k = key(args);
        out.carry(
          [
            leg(
              [
                [380, 250],
                [280, 250],
                [180, 250],
              ],
              t,
              0.9
            ),
          ],
          t,
          t + 1.2,
          {
            role: card!.role,
            col: [[t, ok ? "ink" : "red"]],
            tags: [
              [ok ? `${k} from origin` : "origin 503", t + 0.05, t + 0.45, 28],
            ],
          }
        );
        if (ok) {
          if (!state.keys.includes(k)) state.keys.push(k);
          out.note(t + 0.5, "filled", "ink");
        } else out.note(t + 0.5, "origin failed", "red");
        return {
          exit: "answer",
          role: ok ? ("ink" as const) : ("red" as const),
          token: "data" as const,
        };
      },
    },
    expire: {
      duration: 0.8,
      card: "none",
      description: "an entry's time to live runs out and it is dropped",
      args: keyArg,
      compile({ t, out, state, args }) {
        const k = key(args);
        out.note(t, `${k} ttl running`, "amber");
        state.keys = state.keys.filter((x) => x !== k);
        out.note(t + 0.5, `${k} expired`, "dim");
      },
    },
  },
};

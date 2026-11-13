/**
 * The reference model is written from the contract, not from the reducer:
 * every status has a rank (running < unknown < definitive outcome) and the
 * model decides each transition by rank alone.
 */
import { beforeEach, describe, expect, test, vi } from "vitest";
import * as hegel from "@hegeldev/hegel";
import * as gs from "@hegeldev/hegel/generators";
import {
  activeBackgroundWorkCount,
  applyBackgroundRoster,
  applyBackgroundUpdate,
  EMPTY_BACKGROUND_WORK,
  foldBackgroundEvent,
  markBackgroundWorkStale,
  type BackgroundWorkState,
  type BackgroundWorkStatus,
  type BackgroundWorkUpdate,
} from "./backgroundWork";
import { useChatStore, type ChatSession } from "./chatStore";
import type { BackgroundWorkConversationEvent } from "../types/conversation";

vi.mock("../bindings", () => ({ commands: {}, events: {} }));

const STATUSES: BackgroundWorkStatus[] = [
  "running",
  "completed",
  "failed",
  "cancelled",
  "unknown",
];

const OBSERVED_AT = "2026-11-13T00:00:00Z";

const rank = (status: BackgroundWorkStatus) =>
  status === "running" ? 0 : status === "unknown" ? 1 : 2;

interface Step {
  id: string;
  eventId: string;
  generation: number;
  status: BackgroundWorkStatus;
  live: boolean;
  turn: string | null;
  progress: string | null;
}

interface ModelRecord {
  generation: number;
  status: BackgroundWorkStatus;
  liveRunning: boolean;
  roster: boolean;
  originTurn: string | null;
  progress: string | null;
}

class Model {
  records = new Map<string, ModelRecord>();
  seen = new Set<string>();

  update(step: Step) {
    if (this.seen.has(step.eventId)) return;

    this.seen.add(step.eventId);
    this.apply(step);
  }

  roster(eventId: string, listed: Set<string>, live: boolean) {
    if (this.seen.has(eventId)) return;

    this.seen.add(eventId);

    for (const [id, record] of this.records) {
      if (record.roster && record.status === "running" && !listed.has(id)) {
        record.status = "unknown";
        record.liveRunning = false;
      }
    }

    for (const id of listed) {
      const generation = this.records.get(id)?.generation ?? 0;

      this.apply({
        id,
        eventId,
        generation,
        status: "running",
        live,
        turn: null,
        progress: null,
      });
      this.records.get(id)!.roster = true;
    }
  }

  disconnect() {
    for (const record of this.records.values()) record.liveRunning = false;
  }

  check(state: BackgroundWorkState) {
    const actual = Object.fromEntries(
      Object.values(state.records).map((record) => [
        record.workId,
        {
          generation: record.generation,
          status: record.status,
          liveRunning: record.fresh,
          roster: record.rosterTracked,
          originTurn: record.originTurnId,
          progress: record.progress,
        },
      ])
    );
    const active = [...this.records.values()].filter(
      (record) => record.status === "running" && record.liveRunning
    ).length;

    expect(actual).toEqual(Object.fromEntries(this.records));
    expect(activeBackgroundWorkCount(state)).toBe(active);
  }

  private apply({ id, generation, status, live, turn, progress }: Step) {
    const created: ModelRecord = {
      generation,
      status,
      liveRunning: live && status === "running",
      roster: false,
      originTurn: turn,
      progress,
    };
    const current = this.records.get(id);

    if (!current) {
      this.records.set(id, created);
      return;
    }

    if (generation < current.generation) return;

    if (generation > current.generation) {
      this.records.set(id, {
        ...created,
        originTurn: current.originTurn ?? turn,
      });
      return;
    }

    if (!this.admits(rank(current.status), rank(status), live)) return;

    current.status = status;
    if (progress !== null) current.progress = progress;
    current.liveRunning = status === "running" && (current.liveRunning || live);
  }

  private admits(from: number, to: number, live: boolean) {
    if (from === 2) return to === 2;
    if (from === 1 && to === 0) return live;
    return true;
  }
}

function update(step: Omit<Step, "live">): BackgroundWorkUpdate {
  return {
    eventId: step.eventId,
    workId: step.id,
    generation: step.generation,
    kind: "command",
    providerKind: null,
    status: step.status,
    description: null,
    progress: step.progress,
    launchToolId: null,
    startedAt: null,
    finishedAt: null,
    error: null,
    observedAt: OBSERVED_AT,
    turnId: step.turn,
    threadId: null,
  };
}

function drawStep(tc: hegel.TestCase, eventId: string): Step {
  const id = `w${tc.draw(gs.integers({ minValue: 0, maxValue: 2 }))}`;
  const generation = tc.draw(gs.integers({ minValue: 0, maxValue: 2 }));
  const status = tc.draw(gs.sampledFrom(STATUSES));
  const live = tc.draw(gs.booleans());
  const turn = tc.draw(gs.booleans())
    ? `t${tc.draw(gs.integers({ minValue: 0, maxValue: 2 }))}`
    : null;
  const progress = tc.draw(gs.booleans())
    ? `p${tc.draw(gs.integers({ minValue: 0, maxValue: 3 }))}`
    : null;

  return { id, eventId, generation, status, live, turn, progress };
}

test("projection agrees with the reference model after every operation", () =>
  hegel.test(
    (tc) => {
      const model = new Model();
      let state = EMPTY_BACKGROUND_WORK;
      const delivered: Array<() => void> = [];
      const steps = tc.draw(gs.integers({ minValue: 0, maxValue: 40 }));

      for (let index = 0; index < steps; index++) {
        const choice = tc.draw(gs.integers({ minValue: 0, maxValue: 9 }));
        const eventId = `e${index}`;

        if (choice <= 5) {
          const step = drawStep(tc, eventId);
          tc.note(`update ${JSON.stringify(step)}`);

          const run = () => {
            state = applyBackgroundUpdate(state, update(step), {
              live: step.live,
            }).state;
            model.update(step);
          };

          run();
          delivered.push(run);
        } else if (choice <= 7) {
          const listed = new Set(
            ["w0", "w1", "w2"].filter(() => tc.draw(gs.booleans()))
          );
          const live = tc.draw(gs.booleans());
          tc.note(`roster [${[...listed]}] live=${live}`);

          const run = () => {
            const roster = {
              eventId,
              observedAt: OBSERVED_AT,
              turnId: null,
              work: [...listed].map((workId) => ({
                workId,
                kind: "command" as const,
                providerKind: null,
                description: null,
              })),
            };

            state = applyBackgroundRoster(state, roster, { live }).state;
            model.roster(eventId, listed, live);
          };

          run();
          delivered.push(run);
        } else if (choice === 8) {
          tc.note("disconnect");

          state = markBackgroundWorkStale(state);
          model.disconnect();
        } else if (delivered.length > 0) {
          const redelivered = tc.draw(
            gs.integers({ minValue: 0, maxValue: delivered.length - 1 })
          );
          tc.note(`redeliver #${redelivered}`);

          delivered[redelivered]();
        }

        model.check(state);
      }
    },
    { testCases: 300 }
  ));

function replayEvent(
  id: string,
  eventId: string,
  generation: number,
  status: BackgroundWorkStatus,
  progress: string | null
): BackgroundWorkConversationEvent {
  return {
    kind: "background_work",
    timestamp: OBSERVED_AT,
    update: update({ id, eventId, generation, status, progress, turn: null }),
  };
}

function fold(events: BackgroundWorkConversationEvent[], live: boolean) {
  let state = EMPTY_BACKGROUND_WORK;
  const outcomes: string[] = [];

  for (const event of events) {
    const result = foldBackgroundEvent(state, event, { live });

    state = result.state;
    outcomes.push(
      ...result.transitions.map(
        (record) => `${record.workId}#${record.generation}:${record.status}`
      )
    );
  }

  return { state, outcomes };
}

function lifecycle(state: BackgroundWorkState) {
  return Object.fromEntries(
    Object.values(state.records).map((record) => [
      record.workId,
      [record.generation, record.status, record.progress, record.originTurnId],
    ])
  );
}

function drawHistory(tc: hegel.TestCase, id: string) {
  const events: BackgroundWorkConversationEvent[] = [];
  const length = tc.draw(gs.integers({ minValue: 1, maxValue: 6 }));
  let generation = 0;

  for (let index = 0; index < length; index++) {
    const status = tc.draw(gs.sampledFrom(STATUSES));
    const progress = tc.draw(gs.booleans()) ? `${id}-p${index}` : null;

    events.push(
      replayEvent(id, `${id}-${index}`, generation, status, progress)
    );

    // Only live evidence revives work that ended without an outcome, so a
    // provider that runs it again does so as a new generation.
    if (
      status === "unknown" ||
      (status !== "running" && tc.draw(gs.booleans()))
    ) {
      generation += 1;
    }
  }

  return events;
}

function interleave(
  tc: hegel.TestCase,
  histories: BackgroundWorkConversationEvent[][]
) {
  const cursors = histories.map(() => 0);
  const total = histories.reduce((sum, history) => sum + history.length, 0);
  const interleaved: BackgroundWorkConversationEvent[] = [];

  while (interleaved.length < total) {
    const open = histories
      .map((history, index) => (cursors[index] < history.length ? index : -1))
      .filter((index) => index >= 0);
    const pick =
      open[tc.draw(gs.integers({ minValue: 0, maxValue: open.length - 1 }))];

    interleaved.push(histories[pick][cursors[pick]++]);
  }

  return interleaved;
}

test("live, full replay and paged replay agree; duplicates and interleaving of independent work are invisible", () =>
  hegel.test(
    (tc) => {
      const histories = ["a", "b", "c"].map((id) => drawHistory(tc, id));
      const ordered = histories.flat();
      const interleaved = interleave(tc, histories);
      const duplicated = interleaved.flatMap((event) =>
        tc.draw(gs.booleans()) ? [event, event] : [event]
      );
      const boundary = tc.draw(
        gs.integers({ minValue: 0, maxValue: interleaved.length })
      );

      const live = fold(ordered, true);
      const replay = fold(ordered, false);
      const permuted = fold(duplicated, false);
      const pagedOlder = fold(interleaved.slice(0, boundary), false);
      const pagedFull = fold(interleaved, false);

      expect(lifecycle(replay.state)).toEqual(lifecycle(live.state));
      expect(lifecycle(permuted.state)).toEqual(lifecycle(replay.state));
      expect(lifecycle(pagedFull.state)).toEqual(lifecycle(replay.state));

      expect(replay.outcomes).toEqual(live.outcomes);
      expect([...permuted.outcomes].sort()).toEqual(
        [...replay.outcomes].sort()
      );
      for (const outcome of pagedOlder.outcomes) {
        expect(pagedFull.outcomes).toContain(outcome);
      }

      expect(activeBackgroundWorkCount(replay.state)).toBe(0);
    },
    { testCases: 300 }
  ));

describe("store ownership and isolation", () => {
  const session = (id: string, backend: string): ChatSession => ({
    id,
    label: id,
    messages: [],
    status: "open",
    harness: "claude",
    backendSessionId: backend,
    providerResumeId: null,
    lifecycle: "idle",
    lifecycleError: null,
    streamingAssistant: null,
  });

  const resetSession = (stored: ChatSession): ChatSession => ({
    ...stored,
    backgroundWork: undefined,
    messages: [],
    lifecycle: "idle",
  });

  beforeEach(() => {
    useChatStore.setState({
      sessions: {
        a: { ...session("a", "backend-a"), projectPath: "/one" },
        b: { ...session("b", "backend-b"), projectPath: "/two" },
      },
      activeSessionId: "a",
      paneLayout: { panes: [], activePaneId: null },
      panelOpen: false,
      localSessionSummaries: {},
    });
  });

  test("same native ids in different sessions and projects stay isolated; foreground lifecycle never clears work", () =>
    hegel.test(
      (tc) => {
        useChatStore.setState((state) => ({
          sessions: {
            a: resetSession(state.sessions.a),
            b: resetSession(state.sessions.b),
          },
        }));
        const models = { a: new Model(), b: new Model() };
        const steps = tc.draw(gs.integers({ minValue: 0, maxValue: 30 }));

        for (let index = 0; index < steps; index++) {
          const target = tc.draw(gs.sampledFrom(["a", "b"] as const));

          if (tc.draw(gs.integers({ minValue: 0, maxValue: 3 })) === 0) {
            const lifecycle = tc.draw(
              gs.sampledFrom(["streaming", "idle", "error"] as const)
            );
            useChatStore.getState().setSessionLifecycle(target, lifecycle);
          } else {
            const step: Step = {
              id: `w${tc.draw(gs.integers({ minValue: 0, maxValue: 1 }))}`,
              eventId: `${target}-${index}`,
              generation: 0,
              status: tc.draw(gs.sampledFrom(STATUSES)),
              live: true,
              turn: null,
              progress: null,
            };

            useChatStore.getState().applyBackgroundWork(target, update(step));
            models[target].update(step);
          }

          for (const id of ["a", "b"] as const) {
            const stored = useChatStore.getState().sessions[id];
            const outcomeRows = stored.messages.filter(
              (message) => message.kind === "background_outcome"
            ).length;

            models[id].check(stored.backgroundWork ?? EMPTY_BACKGROUND_WORK);
            expect(outcomeRows).toBeLessThanOrEqual(models[id].seen.size);
          }
        }
      },
      { testCases: 150 }
    ));
});

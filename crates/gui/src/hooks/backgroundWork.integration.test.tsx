/**
 * Drives the bridge goldens (produced from real adapter output by the Rust
 * bridge test) through the event router, the chat store and the panel.
 */
import { act, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type {
  LocalChatBackgroundRosterEvent,
  LocalChatBackgroundWorkEvent,
  LocalChatSessionEndEvent,
  LocalChatTurnStartedEvent,
} from "../bindings";
import claudeEvents from "../test/fixtures/localChatBackground.claude.json";
import codexEvents from "../test/fixtures/localChatBackground.codex.json";
import {
  getLocalChatLifecycle,
  isLocalChatLifecycleBusy,
  useChatStore,
  type ChatMessage,
  type ChatSession,
} from "../stores/chatStore";
import { activeBackgroundWorkCount } from "../stores/backgroundWork";
import { BackgroundActivityPanel } from "../components/ChatWindow/BackgroundActivityPanel";
import {
  resetLocalChatTurnRoutingForTests,
  routeLocalChatBackgroundRosterEvent,
  routeLocalChatBackgroundWorkEvent,
  routeLocalChatSessionEndEvent,
  routeLocalChatTurnStartedEvent,
} from "./useLocalChatEventRouter";

vi.mock("../bindings", () => ({
  commands: {},
  events: {},
}));

type Delivered =
  | {
      event: "local-chat-background-work-event";
      payload: LocalChatBackgroundWorkEvent;
    }
  | {
      event: "local-chat-background-roster-event";
      payload: LocalChatBackgroundRosterEvent;
    }
  | {
      event: "local-chat-turn-started-event";
      payload: LocalChatTurnStartedEvent;
    }
  | {
      event: "local-chat-session-end-event";
      payload: LocalChatSessionEndEvent;
    };

type DeliveredWork = Extract<
  Delivered,
  { event: "local-chat-background-work-event" }
>;

function session(harness: "claude" | "codex"): ChatSession {
  return {
    id: "session",
    label: "Chat",
    messages: [],
    status: "open",
    harness,
    backendSessionId: "backend-1",
    providerResumeId: "root-thread",
    lifecycle: "idle",
    lifecycleError: null,
    streamingAssistant: null,
  };
}

function reset(harness: "claude" | "codex") {
  resetLocalChatTurnRoutingForTests();

  useChatStore.setState({
    sessions: { session: session(harness) },
    activeSessionId: "session",
    paneLayout: { panes: [], activePaneId: null },
    panelOpen: false,
    localSessionSummaries: {},
  });
}

const current = () => useChatStore.getState().sessions.session;

function beginTurn(harness: "claude" | "codex", turnId: string) {
  useChatStore.getState().beginActiveTurn("session");
  useChatStore.getState().setSessionLifecycle("session", "streaming");

  routeLocalChatTurnStartedEvent({
    backend_session_id: "backend-1",
    harness,
    turn_id: turnId,
    thread_id: "root-thread",
    is_root: true,
  });
}

function deliver(item: Delivered) {
  switch (item.event) {
    case "local-chat-background-work-event":
      return routeLocalChatBackgroundWorkEvent(item.payload);

    case "local-chat-background-roster-event":
      return routeLocalChatBackgroundRosterEvent(item.payload);

    case "local-chat-turn-started-event":
      useChatStore.getState().beginActiveTurn("session");
      useChatStore.getState().setSessionLifecycle("session", "streaming");
      return routeLocalChatTurnStartedEvent(item.payload);

    case "local-chat-session-end-event":
      return routeLocalChatSessionEndEvent(item.payload);
  }
}

function outcomes(messages: ChatMessage[]) {
  return messages.flatMap((message) =>
    message.kind === "background_outcome"
      ? [`${message.workId}#${message.generation}:${message.status}`]
      : []
  );
}

function renderPanel() {
  return render(<BackgroundActivityPanel work={current().backgroundWork} />);
}

describe.each([
  {
    harness: "claude" as const,
    events: claudeEvents as Delivered[],
    // The Claude bridge emits no TurnStarted; the runtime's send begins turns.
    synthesizedTurns: { 0: "turn-1", 6: "turn-2" } as Record<number, string>,
    launched: ["b7x2k", "c4d"],
    activeAtSecondTurn: 3,
    finalOutcomes: [
      "c4d#0:completed",
      "b7x2k#0:failed",
      "c4d#1:cancelled",
      "zz9#0:completed",
      "m3q#0:unknown",
    ],
  },
  {
    harness: "codex" as const,
    events: codexEvents as Delivered[],
    synthesizedTurns: {} as Record<number, string>,
    launched: ["call-dev", "call-watch"],
    activeAtSecondTurn: 1,
    finalOutcomes: ["call-dev#0:completed", "call-watch#0:failed"],
  },
])("$harness background work after the reply", (scenario) => {
  beforeEach(() => reset(scenario.harness));

  it("stays visible after the reply and settles while idle or in a later turn", () => {
    const firstEnd = scenario.events.findIndex(
      (item) => item.event === "local-chat-session-end-event"
    );
    let idleChecked = false;

    for (const [index, item] of scenario.events.entries()) {
      const turn = scenario.synthesizedTurns[index];
      const startsSecondTurn =
        turn === "turn-2" ||
        (item.event === "local-chat-turn-started-event" &&
          item.payload.turn_id === "turn-2");

      if (startsSecondTurn) {
        expect(current().activeTurn ?? null).toBeNull();
        expect(activeBackgroundWorkCount(current().backgroundWork)).toBe(
          scenario.activeAtSecondTurn
        );

        idleChecked = true;
      }

      if (turn) beginTurn(scenario.harness, turn);
      expect(deliver(item)).toBe(true);

      if (index === firstEnd) {
        expect(getLocalChatLifecycle(current())).toBe("idle");
        expect(isLocalChatLifecycleBusy(getLocalChatLifecycle(current()))).toBe(
          false
        );
        expect(current().activeTurn ?? null).toBeNull();
        expect(activeBackgroundWorkCount(current().backgroundWork)).toBe(2);

        for (const id of scenario.launched) {
          expect(current().backgroundWork?.records[id]?.originTurnId).toBe(
            "turn-1"
          );
        }

        const { unmount } = renderPanel();
        expect(
          screen.getByTestId("background-activity").dataset.activeCount
        ).toBe("2");
        unmount();
      }
    }

    expect(idleChecked).toBe(true);

    for (const id of scenario.launched) {
      expect(current().backgroundWork?.records[id]?.originTurnId).toBe(
        "turn-1"
      );
    }
    expect(outcomes(current().messages)).toEqual(scenario.finalOutcomes);
    expect(activeBackgroundWorkCount(current().backgroundWork)).toBe(0);

    renderPanel();
    expect(screen.queryAllByTestId("background-activity-row")).toHaveLength(0);
    expect(
      screen.getByText("No background tasks are running.")
    ).toBeInTheDocument();
  });

  it("is idempotent under redelivery of every event", () => {
    for (const [index, item] of scenario.events.entries()) {
      const turn = scenario.synthesizedTurns[index];
      if (turn) beginTurn(scenario.harness, turn);

      deliver(item);
      if (item.event.startsWith("local-chat-background")) deliver(item);
    }

    expect(outcomes(current().messages)).toEqual(scenario.finalOutcomes);
  });

  it("marks running work unconfirmed on disconnect and confirms it again on reconnect", () => {
    const firstEnd = scenario.events.findIndex(
      (item) => item.event === "local-chat-session-end-event"
    );
    for (const [index, item] of scenario.events
      .slice(0, firstEnd + 1)
      .entries()) {
      const turn = scenario.synthesizedTurns[index];
      if (turn) beginTurn(scenario.harness, turn);
      deliver(item);
    }

    act(() => useChatStore.getState().setBackendSessionId("session", null));

    expect(activeBackgroundWorkCount(current().backgroundWork)).toBe(0);
    renderPanel();
    expect(screen.getByText("2 unconfirmed")).toBeInTheDocument();
    expect(outcomes(current().messages)).toEqual([]);

    act(() =>
      useChatStore.getState().setBackendSessionId("session", "backend-2")
    );
    const work = scenario.events.find(
      (item): item is DeliveredWork =>
        item.event === "local-chat-background-work-event" &&
        item.payload.status === "running"
    )!;

    const fromOldBackend = { ...work.payload, event_id: "late-old" };
    const fromNewBackend = {
      ...work.payload,
      backend_session_id: "backend-2",
      event_id: "reconnected",
    };

    expect(routeLocalChatBackgroundWorkEvent(fromOldBackend)).toBe(false);
    expect(routeLocalChatBackgroundWorkEvent(fromNewBackend)).toBe(true);
    expect(activeBackgroundWorkCount(current().backgroundWork)).toBe(1);
  });
});

describe("background work routing isolation", () => {
  beforeEach(() => reset("codex"));

  it("a disposed session receives no further updates", () => {
    const work = (codexEvents as Delivered[]).find(
      (item) => item.event === "local-chat-background-work-event"
    )!;

    act(() => useChatStore.setState({ sessions: {} }));

    expect(deliver(work)).toBe(false);
    expect(useChatStore.getState().sessions).toEqual({});
  });
});

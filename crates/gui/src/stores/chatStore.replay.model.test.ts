import { expect, it, vi } from "vitest";
import * as hegel from "@hegeldev/hegel";
import * as gs from "@hegeldev/hegel/generators";
import { commands, type LoadLocalChatSessionReplayOutput } from "../bindings";
import { useChatStore, type ChatMessage } from "./chatStore";
import { clearPersistedLocalChatSessions } from "../utils/localChatPersistence";

type Reply =
  | { status: "ok"; data: LoadLocalChatSessionReplayOutput }
  | { status: "error"; error: { message: string } };
const message = (n: number): ChatMessage => ({
  kind: "user",
  text: `message ${n}`,
  timestamp: new Date(n * 1000).toISOString(),
});
const line = (n: number) =>
  JSON.stringify({
    version: 1,
    event_id: `event-${n}`,
    stream_id: "model",
    sequence: n,
    correlation: { session_id: "model", thread_id: "model" },
    timestamp: new Date(n * 1000).toISOString(),
    semantics: "snapshot",
    type: "turn_input",
    data: { thread_id: "model", content: `message ${n}`, provenance: "human" },
  });

it(
  "generated replay schedules preserve history across append, failure, retry and retired responses",
  () =>
    hegel.testAsync(
      async (tc) => {
        const actions = tc.draw(
          gs.arrays(
            gs.sampledFrom([
              "load",
              "append",
              "resolve",
              "fail",
              "evict",
              "reopen",
              "newest-response",
            ] as const),
            { minSize: 1, maxSize: 45 }
          )
        );
        localStorage.clear();
        clearPersistedLocalChatSessions();
        useChatStore.setState({
          sessions: {},
          activeSessionId: null,
          paneLayout: { panes: [], activePaneId: null },
          panelOpen: false,
        });
        let count = 12,
          epoch = 0,
          revision = 0;
        let evicted = false;
        let visible = new Set([10, 11, 12]);
        const pending: {
          resolve: (reply: Reply) => void;
          reply: Reply;
          epoch: number;
          ids: number[];
        }[] = [];
        const operations: Promise<void>[] = [];
        const transactions = new Map<number, Set<number>>();
        const active = new Set<number>();
        let issuingEpoch = 0;
        const id = useChatStore
          .getState()
          .openSession("Replay model", "/model");
        const cursor = (end: number) => `${revision}/${end}`;
        const seed = () => {
          const ids = [count - 2, count - 1, count];
          visible = new Set(ids);
          useChatStore.setState((state) => ({
            sessions: {
              ...state.sessions,
              [id]: {
                ...state.sessions[id],
                id,
                providerResumeId: "model",
                selectedSpeedTier: "default",
                messages: ids.map(message),
                providerReplay: {
                  generation: epoch + 100,
                  lines: ids.map(line),
                  cacheKey: String(revision),
                  nextCursor: cursor(ids[0] - 1),
                  hasMore: true,
                  loading: null,
                  loaded: true,
                  error: null,
                  installedMessages: ids.map(message),
                  seenCursors: [],
                },
              },
            },
          }));
        };
        seed();
        const warn = vi
          .spyOn(console, "warn")
          .mockImplementation(() => undefined);
        const load = vi
          .spyOn(commands, "loadLocalChatSessionReplay")
          .mockImplementation((input) => {
            let end = count;
            const owner = issuingEpoch;
            let error: string | undefined;
            if (input.cursor) {
              const [version, boundary] = input.cursor.split("/").map(Number);
              end = boundary;
              if (version !== revision)
                error =
                  "transcript replay cursor no longer matches the transcript revision";
              else if (evicted) {
                error =
                  "transcript replay cursor is outside the retained event window";
                evicted = false;
              }
            }
            const start = Math.max(0, end - 3);
            const ids = Array.from(
              { length: end - start },
              (_, n) => start + n + 1
            );
            const reply: Reply = error
              ? { status: "error", error: { message: error } }
              : {
                  status: "ok",
                  data: {
                    events: ids.map(line),
                    cache_key: String(revision),
                    next_cursor: start ? cursor(start) : null,
                    has_more: start > 0,
                  },
                };
            return new Promise((resolve) =>
              pending.push({
                resolve,
                reply,
                epoch: owner,
                ids,
              })
            );
          });
        const flush = async () => {
          for (let n = 0; n < 20; n++) await Promise.resolve();
        };
        const check = () => {
          const session = useChatStore.getState().sessions[id];
          const actual = session.messages.map((m) =>
            m.kind === "user" ? Number(m.text.split(" ")[1]) : -1
          );
          expect(session.providerReplay?.loading !== null).toBe(
            active.has(epoch)
          );
          expect(session.providerReplay?.hasMore).toBe(
            Math.min(...visible) > 1
          );
          expect(actual).toEqual([...visible].sort((a, b) => a - b));
          expect(new Set(actual).size).toBe(actual.length);
        };
        const deliver = async (index: number, fail = false) => {
          const request = pending.splice(index, 1)[0];
          if (!request) return;
          const before = useChatStore.getState().sessions[id];
          if (!fail && request.reply.status === "ok") {
            for (const n of request.ids)
              transactions.get(request.epoch)?.add(n);
          }
          issuingEpoch = request.epoch;
          request.resolve(
            fail
              ? { status: "error", error: { message: "injected disk failure" } }
              : request.reply
          );
          await flush();
          const after = useChatStore.getState().sessions[id];
          if (request.epoch !== epoch) expect(after).toBe(before);
          else if (fail)
            expect(after.providerReplay?.error).toBe("injected disk failure");
          check();
        };
        const beginLoad = () => {
          const owner = epoch;
          const canLoad = !active.has(owner) && Math.min(...visible) > 1;
          if (canLoad) {
            transactions.set(owner, new Set<number>());
            active.add(owner);
          }
          const responses = transactions.get(owner);
          issuingEpoch = owner;
          operations.push(
            useChatStore
              .getState()
              .loadOlderReplayMessages(id)
              .then((applied) => {
                // The operation result determines commit vs rollback; expected contents
                // come only from delivered server events and independently tracked live IDs.
                if (canLoad) active.delete(owner);
                if (applied && owner === epoch)
                  for (const n of responses ?? []) visible.add(n);
              })
          );
        };
        try {
          for (const action of actions) {
            if (action === "load") {
              const before = load.mock.calls.length;
              const busy = active.has(epoch);
              beginLoad();
              if (busy) expect(load.mock.calls.length).toBe(before);
            } else if (action === "append") {
              count++;
              revision++;
              useChatStore.getState().addMessage(id, message(count));
              visible.add(count);
            } else if (action === "evict") evicted = true;
            else if (action === "reopen") {
              epoch++;
              seed();
            } else
              await deliver(
                action === "newest-response" ? pending.length - 1 : 0,
                action === "fail"
              );
            await flush();
            check();
          }
          for (let n = 0; n < 200 && pending.length; n++) await deliver(0);
          for (
            let n = 0;
            n < 30 &&
            useChatStore.getState().sessions[id].providerReplay?.hasMore;
            n++
          ) {
            beginLoad();
            for (let k = 0; k < 200 && pending.length; k++) await deliver(0);
          }
          expect(pending).toHaveLength(0);
          await Promise.all(operations);
          expect([...visible].sort((a, b) => a - b)).toEqual(
            Array.from({ length: count }, (_, n) => n + 1)
          );
          check();
        } finally {
          load.mockRestore();
          warn.mockRestore();
          useChatStore.setState({ sessions: {} });
          localStorage.clear();
        }
      },
      { testCases: 1000 }
    ),
  30_000
);

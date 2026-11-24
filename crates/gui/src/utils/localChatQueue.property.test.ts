import { expect, it, vi } from "vitest";
import * as hegel from "@hegeldev/hegel";
import * as gs from "@hegeldev/hegel/generators";
import type { LocalChatSessionIndexEntry } from "../bindings";
import type { ChatSession } from "../stores/chatStore";

const io = vi.hoisted(() => ({
  catalog: null as LocalChatSessionIndexEntry | null,
  queue: null as LocalChatSessionIndexEntry | null,
  locked: false,
  send: vi.fn(),
}));

vi.mock("../bindings", () => ({
  events: {},
  commands: {
    sendLocalChatMessage: io.send,
    createLocalChatSession: io.send,
    loadLocalChatSessionIndex: async () =>
      io.locked
        ? { status: "error", error: { message: "Index locked" } }
        : {
            status: "ok",
            data: io.catalog ? [structuredClone(io.catalog)] : [],
          },
    loadLocalChatQueues: async () => ({
      status: "ok",
      data: io.queue ? [structuredClone(io.queue)] : [],
    }),
    saveLocalChatQueue: async (
      _id: string,
      entry: LocalChatSessionIndexEntry | null
    ) => {
      io.queue = structuredClone(entry);
      return { status: "ok", data: null };
    },
    saveLocalChatSessionIndex: async (input: {
      sessions: LocalChatSessionIndexEntry[];
    }) => {
      io.catalog = structuredClone(input.sessions[0] ?? null);
      return { status: "ok", data: null };
    },
  },
}));

const catalogSnapshot = () => io.catalog;

async function boot() {
  vi.resetModules();
  const storage = await import("./localChatPersistence");
  const { useChatStore } = await import("../stores/chatStore");
  const { flushNextQueuedMessage } =
    await import("../hooks/localChatTurnDelivery");
  const router = await import("../hooks/useLocalChatEventRouter");
  await useChatStore.getState().hydrateLocalSessionIndex();
  return { storage, useChatStore, flushNextQueuedMessage, router };
}

const id = "acp-property-chat";
const backend = "acp-property-backend";
const session: ChatSession = {
  id,
  label: "ACP property chat",
  harness: "acp",
  status: "open",
  lifecycle: "idle",
  backendSessionId: backend,
  providerResumeId: "provider-thread",
  providerId: "local:acp:property",
  projectPath: "/test/project",
  messages: [],
  hasUserMessage: true,
  queuePaused: false,
};

it(
  "matches a FIFO recovery model across delivery, deletion and app restart",
  () =>
    hegel.testAsync(
      async (tc) => {
        const actions = tc.draw(
          gs.arrays(
            gs.sampledFrom([
              "enqueue",
              "enqueue",
              "enqueue-other",
              "completed",
              "stopped",
              "turn-error",
              "session-error",
              "resume",
              "command-error",
              "reject",
              "discard",
              "clear",
              "remote-delete",
              "remote-update",
              "restart",
              "restart-locked",
            ] as const),
            { minSize: 2, maxSize: 22 }
          )
        );
        tc.note(JSON.stringify(actions));
        localStorage.clear();
        io.catalog = io.queue = null;
        io.locked = false;
        io.send.mockReset();
        io.send.mockResolvedValue({ status: "ok", data: null });
        let app = await boot();
        const { setState } = app.useChatStore;
        setState({ sessions: { [id]: session } });
        await app.storage.persistLocalChatSession(session);

        let queue: string[] = [];
        let paused = false;
        let deleted = false;
        for (const [index, action] of actions.entries()) {
          const store = app.useChatStore.getState();
          const before = io.send.mock.calls.length;
          if (action === "restart" || action === "restart-locked") {
            io.locked = action === "restart-locked";
            app = await boot();
            paused = queue.length > 0;
          } else if (!deleted && store.sessions[id]) {
            if (action === "enqueue" || action === "enqueue-other") {
              const message = action === "enqueue" ? "duplicate" : "other";
              queue.push(message);
              store.enqueueQueuedMessage(id, message);
            } else if (
              action === "discard" ||
              action === "clear" ||
              action === "remote-delete"
            ) {
              queue = [];
              paused = false;
              if (action === "discard") store.clearQueuedMessages(id);
              else if (action === "clear") {
                store.clearMessages(id);
                deleted = true;
              } else {
                // The catalog CDC delete is authoritative after local writes settle.
                await app.storage.persistLocalChatSession(store.sessions[id]);
                if (io.locked) {
                  io.locked = false;
                  await app.storage.hydrateLocalChatSessionIndex();
                  await app.storage.persistLocalChatSession(store.sessions[id]);
                }
                await app.storage.retryCatalogSave();
                await vi.waitFor(() =>
                  expect(
                    app.storage.applyRemoteLocalChatSession(id, null)
                  ).toBeNull()
                );
                io.catalog = null;
                app.useChatStore.setState({ sessions: {} });
                deleted = true;
              }
            } else if (action === "remote-update") {
              const snapshot = catalogSnapshot();
              if (snapshot)
                app.storage.applyRemoteLocalChatSession(id, {
                  ...snapshot,
                  title: "Remote title",
                });
            } else if (
              action === "session-error" ||
              action === "completed" ||
              action === "stopped" ||
              action === "turn-error"
            ) {
              const turn = `turn-${index}`;
              store.setBackendSessionId(id, backend);
              store.beginActiveTurn(id);
              app.router.routeLocalChatTurnStartedEvent({
                backend_session_id: backend,
                harness: "acp",
                is_root: true,
                turn_id: turn,
              });
              if (action === "session-error") {
                app.router.routeLocalChatSessionErrorEvent({
                  backend_session_id: backend,
                  harness: "acp",
                  is_root: true,
                  turn_id: turn,
                  error: "Provider disconnected",
                });
              } else {
                if (action === "stopped") store.markActiveTurnStopping(id);
                app.router.routeLocalChatSessionEndEvent({
                  backend_session_id: backend,
                  harness: "acp",
                  is_root: true,
                  turn_id: turn,
                  duration_ms: 0,
                  cost_usd: 0,
                  num_turns: 1,
                  result: "",
                  is_error: action !== "completed",
                  context_tokens: 0,
                  context_window: 0,
                  completion_status:
                    action === "completed"
                      ? "completed"
                      : action === "stopped"
                        ? "interrupted"
                        : "failed",
                });
              }
              if (action === "completed" && !paused && queue.length) {
                const head = queue.shift();
                await vi.waitFor(() =>
                  expect(io.queue?.queuedMessages ?? []).toEqual(queue)
                );
                expect(
                  io.send.mock.calls.slice(before).map((call) => call[1])
                ).toEqual([head]);
              } else if (action !== "completed") paused = queue.length > 0;
            } else if (queue.length) {
              store.setBackendSessionId(id, backend);
              store.setSessionLifecycle(id, "idle");
              if (action === "command-error")
                io.send.mockResolvedValueOnce({
                  status: "error",
                  error: { SendFailed: "Rejected" },
                });
              if (action === "reject")
                io.send.mockRejectedValueOnce(new Error("Disconnected"));
              const head = queue[0];
              const results = await Promise.all([
                app.flushNextQueuedMessage(id, true),
                app.flushNextQueuedMessage(id, true),
              ]);
              expect(
                io.send.mock.calls.slice(before).map((call) => call[1])
              ).toEqual([head]);
              expect(results).toEqual([action === "resume", false]);
              if (action === "resume") queue.shift();
              paused = action !== "resume";
            }
          }
          await vi.waitFor(() =>
            expect(io.queue?.queuedMessages ?? []).toEqual(queue)
          );
          const actual = app.useChatStore.getState().sessions[id];
          expect(actual?.queuedMessages ?? []).toEqual(queue);
          expect(!!actual?.queuePaused).toBe(paused);
          if (deleted) expect(io.queue).toBeNull();
        }
      },
      { testCases: 35 }
    ),
  30_000
);

it(
  "never consumes a replacement with the same text after an in-flight acknowledgement",
  () =>
    hegel.testAsync(
      async (tc) => {
        const text = tc.draw(gs.sampledFrom(["same", "重複", "🚀"]));
        localStorage.clear();
        io.queue = io.catalog = null;
        io.locked = false;
        io.send.mockReset();
        let acknowledge!: (value: unknown) => void;
        io.send.mockReturnValueOnce(
          new Promise((resolve) => {
            acknowledge = resolve;
          })
        );
        const app = await boot();
        app.useChatStore.setState({ sessions: { [id]: session } });
        const store = app.useChatStore.getState();
        store.enqueueQueuedMessage(id, text);
        const inFlight = app.flushNextQueuedMessage(id, true);
        const overlapping = app.flushNextQueuedMessage(id, true);
        expect(io.send).toHaveBeenCalledTimes(1);
        store.clearQueuedMessages(id);
        store.enqueueQueuedMessage(id, text);
        acknowledge({ status: "ok", data: null });
        expect(await Promise.all([inFlight, overlapping])).toEqual([
          true,
          false,
        ]);
        expect(app.useChatStore.getState().sessions[id].queuedMessages).toEqual(
          [text]
        );
        await vi.waitFor(() =>
          expect(io.queue?.queuedMessages).toEqual([text])
        );
      },
      { testCases: 12 }
    ),
  15_000
);

import { act, renderHook } from "@testing-library/react";
import * as hegel from "@hegeldev/hegel";
import * as gs from "@hegeldev/hegel/generators";
import { expect, it, vi } from "vitest";
import { commands, type AssociationWorktree } from "../bindings";
import { useChatStore } from "../stores/chatStore";
import {
  clearPersistedLocalChatSessions,
  loadPersistedLocalChatSession,
} from "../utils/localChatPersistence";
import { useChatAssociation, useChatAssociationDriver } from "./useChatAssociation";

vi.mock("../bindings", () => ({
  commands: {
    getCurrentProjectPath: vi.fn(),
    resolveChatAssociation: vi.fn(),
  },
}));

const main = { path: "/repo/main", branch: "trunk" };
const linked = { path: "/repo/feature", branch: "feature" };
const resolve = vi.mocked(commands.resolveChatAssociation);

function useDrivenAssociation(sessionId: string) {
  useChatAssociationDriver(sessionId);
  return useChatAssociation(sessionId);
}

it(
  "generated conversation histories preserve worktrees unless reassociation succeeds",
  async () => {
    const log = vi.spyOn(console, "info").mockImplementation(() => undefined);
    try {
      await hegel.testAsync(
        async (tc) => {
          const hasDefault = tc.draw(gs.booleans());
          const actions = tc.draw(
            gs.arrays(
              gs.sampledFrom([
                "reopen",
                "keep",
                "unresolved",
                "select-main",
                "select-linked",
              ] as const),
              { minSize: 1, maxSize: 20 }
            )
          );
          clearPersistedLocalChatSessions();
          const store = useChatStore.getState();
          store.reset();
          resolve.mockReset();
          vi.mocked(commands.getCurrentProjectPath).mockResolvedValue({
            status: "ok",
            data: main.path,
          });

          let expected: AssociationWorktree | null = hasDefault ? main : null;
          const id = store.openProjectSession("New Chat", main.path, expected);
          const driver = renderHook(() => useDrivenAssociation(id));
          const check = () => {
            const association = {
              worktreePath: expected?.path ?? null,
              branch: expected?.branch ?? null,
            };
            expect(driver.result.current.record).toMatchObject(association);
            const saved = loadPersistedLocalChatSession(id);
            expect(saved).not.toBeNull();
            if (saved?.association == null) {
              expect(expected).toBeNull();
            } else {
              expect(saved.association).toMatchObject(association);
            }
          };

          try {
            check();
            for (const [index, action] of actions.entries()) {
              const requests = resolve.mock.calls.length;
              if (action === "reopen") {
                await act(async () => {
                  store.closeSession(id);
                  expect(store.openSession("New Chat", main.path, main)).toBe(id);
                });
                expect(resolve).toHaveBeenCalledTimes(requests);
              } else {
                const target =
                  action === "select-main"
                    ? main
                    : action === "select-linked"
                      ? linked
                      : null;
                const name = target?.path ?? "/repo/unknown";
                resolve.mockResolvedValueOnce({
                  status: "ok",
                  data: {
                    selection: { kind: "keep" },
                    worktree: target,
                    worktrees: [main, linked],
                    create_worktree: false,
                    create_ticket: false,
                    diagnostic: action === "unresolved" ? "Unknown worktree" : null,
                  },
                });
                await act(async () => {
                  store.addMessage(id, {
                    kind: "user",
                    timestamp: new Date((index + 1) * 1000).toISOString(),
                    text:
                      action === "keep"
                        ? "Show the README"
                        : `Associate this conversation with worktree ${name}`,
                  });
                });
                expect(resolve).toHaveBeenCalledTimes(requests + 1);
                if (target) expected = target;
              }
              check();
            }
          } finally {
            driver.unmount();
            store.reset();
            clearPersistedLocalChatSessions();
          }
        },
        { testCases: 100 }
      );
    } finally {
      log.mockRestore();
    }
  },
  30_000
);

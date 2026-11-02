import { useEffect } from "react";
import { fireEvent, render, within } from "@testing-library/react";
import { expect, test, vi } from "vitest";
import * as hegel from "@hegeldev/hegel";
import * as gs from "@hegeldev/hegel/generators";
import { ToolActivityGroup } from "./ToolActivityGroup";
import { ChatSessionContext } from "../toolChange/ChatSessionContext";
import type { ToolMessage } from "../types";

function ExpensiveRaw({ id, mounted }: { id: string; mounted: Set<string> }) {
  useEffect(() => {
    mounted.add(id);
    return () => {
      mounted.delete(id);
    };
  }, [id, mounted]);
  return <span>raw renderer for {id}</span>;
}

test(
  "generated arrivals, replay, disclosure toggles and session switches preserve raw data and lazy mounts",
  () =>
    hegel.test(
      (tc) => {
        const initialCount = tc.draw(gs.integers({ minValue: 1, maxValue: 4 }));
        const argument = tc.draw(gs.text({ maxSize: 50 }));
        const output = tc.draw(gs.text({ maxSize: 80 }));
        const actions = tc.draw(
          gs.arrays(
            gs.record({
              kind: gs.sampledFrom([
                "group",
                "raw",
                "append",
                "result",
                "replay",
                "session",
              ] as const),
              index: gs.integers({ minValue: 0, maxValue: 10 }),
              error: gs.booleans(),
            }),
            { minSize: 1, maxSize: 25 }
          )
        );
        vi.stubGlobal("Worker", undefined);
        const mounted = new Set<string>();
        let nextId = 0,
          session = 0;
        const newCall = (): ToolMessage => {
          const evt = `call-${nextId++}`;
          return {
            type: "tool",
            body: <ExpensiveRaw id={evt} mounted={mounted} />,
            evt,
            toolId: evt,
            name: "exec",
            status: "pending",
            activityInput: { name: "exec", input: { code: argument } },
            rawInput: ` \n${JSON.stringify({ code: argument, id: evt })}\t `,
          };
        };
        let calls = Array.from({ length: initialCount }, newCall);
        let groupOpen = false;
        const rawOpen = new Set<string>();
        const view = () => (
          <ChatSessionContext.Provider value={`session-${session}`}>
            <ToolActivityGroup calls={calls} />
          </ChatSessionContext.Provider>
        );
        const ui = render(view());
        const queries = within(ui.container);
        const assertModel = () => {
          const group = queries.getByRole("button", { name: /\d+ calls? for/ });
          expect(group).toHaveAttribute("aria-expanded", String(groupOpen));
          expect(group.textContent).toMatch(
            new RegExp(`^${calls.length} calls? for`)
          );
          const visible = groupOpen
            ? calls.filter((c) => rawOpen.has(c.evt))
            : [];
          expect([...mounted].sort()).toEqual(
            visible
              .filter((c) => c.recordedResult === undefined)
              .map((c) => c.evt)
              .sort()
          );
          const expectedRaw = visible.flatMap((c) =>
            c.recordedResult === undefined
              ? [c.rawInput]
              : [c.rawInput, c.recordedResult]
          );
          expect(
            [...ui.container.querySelectorAll("pre")].map((p) => p.textContent)
          ).toEqual(expectedRaw);
          expect(
            queries.queryAllByRole("button", {
              name: /Raw arguments and recorded result/,
            })
          ).toHaveLength(groupOpen ? calls.length : 0);
          if (groupOpen)
            queries
              .getAllByRole("button", {
                name: /Raw arguments and recorded result/,
              })
              .forEach((button, index) => {
                expect(button).toHaveAttribute(
                  "aria-expanded",
                  String(rawOpen.has(calls[index].evt))
                );
              });
        };
        try {
          // Establish an open raw body before exploring schedules, including late results.
          fireEvent.click(
            queries.getByRole("button", { name: /\d+ calls? for/ })
          );
          groupOpen = true;
          fireEvent.click(
            queries.getAllByRole("button", {
              name: /Raw arguments and recorded result/,
            })[0]
          );
          rawOpen.add(calls[0].evt);
          assertModel();
          for (const [step, action] of actions.entries()) {
            const index = action.index % calls.length;
            if (action.kind === "group") {
              fireEvent.click(
                queries.getByRole("button", { name: /\d+ calls? for/ })
              );
              groupOpen = !groupOpen;
            } else if (action.kind === "raw" && groupOpen) {
              fireEvent.click(
                queries.getAllByRole("button", {
                  name: /Raw arguments and recorded result/,
                })[index]
              );
              const id = calls[index].evt;
              if (rawOpen.has(id)) rawOpen.delete(id);
              else rawOpen.add(id);
            } else if (action.kind === "append") {
              calls = [...calls, newCall()];
              ui.rerender(view());
            } else if (action.kind === "result") {
              calls = calls.map((c, i) =>
                i === index
                  ? {
                      ...c,
                      recordedResult:
                        step % 2 === 0 ? output : `${output}\nrecorded-${step}`,
                      status: action.error ? "err" : "done",
                      error: action.error,
                    }
                  : c
              );
              ui.rerender(view());
            } else if (action.kind === "replay") {
              calls = calls.map((c) => ({
                ...c,
                activityInput: c.activityInput && {
                  ...c.activityInput,
                  input: { ...c.activityInput.input },
                },
              }));
              ui.rerender(view());
            } else if (action.kind === "session") {
              session++;
              groupOpen = false;
              rawOpen.clear();
              ui.rerender(view());
            }
            assertModel();
          }
        } finally {
          ui.unmount();
          expect(mounted.size).toBe(0);
          vi.unstubAllGlobals();
        }
      },
      { testCases: 60 }
    ),
  // Sixty DOM-heavy generated cases take longer on two-core CI runners.
  60000
);

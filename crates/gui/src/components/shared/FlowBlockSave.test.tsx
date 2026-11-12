/**
 * Saving a ```flow block as a ticket artifact: the same rules as statechart
 * blocks (offered only for a renderable spec in a ticket-associated chat,
 * retired across project switches, reset when the chat's ticket changes),
 * plus a model-based test that drives generated association, save, settle
 * and project-switch schedules against an independent model.
 */
import type { ReactNode } from "react";
import {
  act,
  cleanup,
  fireEvent,
  render as renderDom,
  screen,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as hegel from "@hegeldev/hegel";
import * as gs from "@hegeldev/hegel/generators";
import type { Artifact } from "../../bindings";
import { queryClient } from "../../query/queryClient";
import { queryKeys } from "../../query/queryKeys";
import { useChatStore } from "../../stores/chatStore";
import {
  getProjectScopeGeneration,
  resetProjectScopedStores,
} from "../../stores/projectScopedStores";
import { ChatSessionContext } from "../thread/toolChange/ChatSessionContext";
import { MarkdownContent } from "./MarkdownContent";

const save = vi.hoisted(() => vi.fn());
const list = vi.hoisted(() => vi.fn());
vi.mock("../../bindings", () => ({
  commands: { saveFlowArtifact: save, listArtifactPresentations: list },
}));
vi.mock("./CodeSnippet", () => ({
  default: ({ source }: { source: string }) => <code>{source}</code>,
}));

const spec = `version: 1
parts:
  - { id: src, kind: source, position: { x: 0, y: 0 } }
  - { id: w, kind: worker, position: { x: 400, y: 0 } }
rails:
  - { id: jobs, from: src.out, to: w.in }
cards:
  - { id: job, token: request, label: J }
story:
  - caption: a job is sent
    steps:
      - { verb: send, part: src, card: job }
  - caption: the worker runs it
    steps:
      - { verb: stage, part: w, card: job, via: jobs }
      - { verb: finish, part: w, card: job }`;
const fence = (body = spec) => `\`\`\`flow\n${body}\n\`\`\``;

const flowArtifact = (id: string, body = spec): Artifact => ({
  id,
  project_id: null,
  filename: "diagram.flow.yaml",
  body,
  logical_name: null,
  metadata: {
    version: 1,
    content_kind: "flow",
    format: "yaml",
    origin: "chat",
    presentation: "rendered",
    extensions: { flow_format: "flow-v1" },
  },
  created_at: null,
  updated_at: null,
});
const artifact = flowArtifact("860cde1b-9093-42ff-a19d-7453f3b7891e");

const tickets = [
  "21e32ec0-1d73-4c72-afa5-cb955f9a2ab4",
  "a001bc77-964a-4106-9ced-3ee95b5b77f7",
];
const association = (id: string | null, entityLevel = "ticket") => ({
  ticketId: id,
  entityLevel,
  ticketTitle: "Flow ticket",
  worktreePath: null,
  branch: null,
  lastProcessedAt: null,
  processedAtCount: 0,
  awaitingWorktree: null,
  recentWorktrees: [],
});

let sessionId: string;
const inChat = (ui: ReactNode, id = sessionId) => (
  <ChatSessionContext.Provider value={id}>{ui}</ChatSessionContext.Provider>
);
const render = (ui: ReactNode) => renderDom(inChat(ui));
const saveButton = () =>
  screen.queryByRole("button", { name: "Save as artifact" });

beforeEach(() => {
  queryClient.clear();
  useChatStore.setState({ sessions: {} });
  sessionId = useChatStore.getState().openSession("Flow check");
  useChatStore
    .getState()
    .setSessionAssociation(sessionId, association(tickets[0]));
  save.mockReset().mockResolvedValue({ status: "ok", data: artifact });
  list.mockReset().mockResolvedValue({ status: "ok", data: [artifact] });
});
afterEach(() => {
  cleanup();
  queryClient.clear();
  vi.useRealTimers();
});

describe("saving a ```flow block", () => {
  it("saves the original source to the chat's ticket once, then embeds the saved artifact", async () => {
    let resolve!: (value: unknown) => void;
    save.mockReturnValue(new Promise((done) => (resolve = done)));
    render(<MarkdownContent text={fence()} />);
    expect(screen.getByTestId("flow-player")).toBeInTheDocument();
    fireEvent.click(saveButton()!);
    fireEvent.click(screen.getByRole("button", { name: "Saving…" }));
    expect(screen.getByRole("button", { name: "Saving…" })).toBeDisabled();
    expect(save).toHaveBeenCalledExactlyOnceWith(spec, tickets[0]);
    await act(async () => resolve({ status: "ok", data: artifact }));
    expect(
      screen.getByRole("link", { name: `Open artifact ${artifact.id}` })
    ).toHaveAttribute("data-vtb-entity-id", artifact.id);
    // The block's own player gives way to the saved artifact's embed.
    expect(await screen.findByTestId("flow-preview")).toBeInTheDocument();
    expect(screen.getAllByTestId("flow-player")).toHaveLength(1);
    expect(
      queryClient.getQueryData(
        queryKeys.artifacts.presentations(getProjectScopeGeneration())
      )
    ).toEqual([artifact]);
  });

  it.each([
    ["unparseable YAML", "version: 1\nparts: [\n"],
    ["an unknown part kind", spec.replace("kind: worker", "kind: nope")],
  ])("offers no save for %s and shows the compiler error", (_, body) => {
    render(<MarkdownContent text={fence(body)} />);
    expect(screen.getByTestId("flow-errors")).toHaveTextContent(
      "Flow spec has"
    );
    expect(saveButton()).toBeNull();
  });

  it.each([
    ["a general chat", null, "ticket"],
    ["an epic chat", tickets[0], "epic"],
    ["a task chat", tickets[0], "task"],
  ])("offers no save in %s", (_, id, level) => {
    useChatStore
      .getState()
      .setSessionAssociation(sessionId, association(id, level));
    render(<MarkdownContent text={fence()} />);
    expect(screen.getByTestId("flow-player")).toBeInTheDocument();
    expect(saveButton()).toBeNull();
  });

  it("offers no save outside a conversation", () => {
    renderDom(<MarkdownContent text={fence()} />);
    expect(screen.getByTestId("flow-player")).toBeInTheDocument();
    expect(saveButton()).toBeNull();
  });

  it.each(["command", "transport"])(
    "shows a %s failure and permits retry",
    async (kind) => {
      if (kind === "command")
        save.mockResolvedValueOnce({
          status: "error",
          error: { message: "Save failed" },
        });
      else save.mockRejectedValueOnce(new Error("Save failed"));
      render(<MarkdownContent text={fence()} />);
      fireEvent.click(saveButton()!);
      expect(await screen.findByRole("alert")).toHaveTextContent(
        "Unable to save artifact: Save failed"
      );
      fireEvent.click(saveButton()!);
      await screen.findByText("Saved artifact");
      expect(save).toHaveBeenCalledTimes(2);
    }
  );
});

// Model: the chat's ticket (none, epic, or one of two tickets), the block's
// save status, and pending requests tagged with the block instance that
// issued them. A ticket change or a project switch replaces the instance, so
// its pending saves can no longer change what the block shows.
type Status = "idle" | "saving" | "saved" | "error";
type Action =
  | { kind: "associate"; to: "none" | "epic" | 0 | 1 }
  | { kind: "click" }
  | { kind: "settle"; request: number; ok: boolean }
  | { kind: "project" };

it(
  "model: generated association, save, settle and project schedules match the save rules",
  () =>
    hegel.testAsync(
      async (tc) => {
        const action = gs.oneOf<Action>(
          gs.record({
            kind: gs.just("associate" as const),
            to: gs.sampledFrom(["none", "epic", 0, 1] as const),
          }),
          gs.record({ kind: gs.just("click" as const) }),
          gs.record({
            kind: gs.just("settle" as const),
            request: gs.integers({ minValue: 0, maxValue: 8 }),
            ok: gs.booleans(),
          }),
          gs.record({ kind: gs.just("project" as const) })
        );
        const actions: Action[] = tc.draw(
          gs.arrays(action, { minSize: 1, maxSize: 20 })
        );

        queryClient.clear();
        resetProjectScopedStores();
        let session = useChatStore.getState().openSession("Model");
        useChatStore
          .getState()
          .setSessionAssociation(session, association(tickets[0]));

        const model = {
          ticket: tickets[0] as string | null,
          instance: 0,
          status: "idle" as Status,
          calls: [] as [string, string][],
        };
        const requests: {
          instance: number;
          settled: boolean;
          resolve: (v: unknown) => void;
        }[] = [];
        save.mockReset().mockImplementation(
          () =>
            new Promise((resolve) =>
              requests.push({
                instance: model.instance,
                settled: false,
                resolve,
              })
            )
        );
        list.mockReset().mockResolvedValue({ status: "ok", data: [] });

        const view = () => inChat(<MarkdownContent text={fence()} />, session);
        const ui = renderDom(view());
        try {
          for (const a of actions) {
            await act(async () => {
              if (a.kind === "associate") {
                const ticket =
                  a.to === "none" || a.to === "epic" ? null : tickets[a.to];
                const next =
                  a.to === "epic"
                    ? association(tickets[0], "epic")
                    : association(ticket);
                useChatStore.getState().setSessionAssociation(session, next);
                if (ticket !== model.ticket) {
                  model.ticket = ticket;
                  model.instance++;
                  model.status = "idle";
                }
              } else if (a.kind === "project") {
                resetProjectScopedStores();
                // The new project's chat starts without a ticket.
                session = useChatStore.getState().openSession("Model");
                useChatStore
                  .getState()
                  .setSessionAssociation(session, association(null));
                model.ticket = null;
                model.instance++;
                model.status = "idle";
              } else if (a.kind === "click") {
                const button = saveButton();
                tc.note(`click: button ${button ? "present" : "absent"}`);
                if (button) {
                  fireEvent.click(button);
                  model.calls.push([spec, model.ticket!]);
                  model.status = "saving";
                }
              } else {
                const r = requests[a.request % Math.max(requests.length, 1)];
                if (r && !r.settled) {
                  r.settled = true;
                  r.resolve(
                    a.ok
                      ? { status: "ok", data: artifact }
                      : { status: "error", error: { message: "nope" } }
                  );
                  if (r.instance === model.instance)
                    model.status = a.ok ? "saved" : "error";
                }
              }
              ui.rerender(view());
            });

            const saving = screen.queryByRole("button", { name: "Saving…" });
            const saved = screen.queryByText("Saved artifact");
            const failed = screen.queryByText(/Unable to save artifact/);
            const offered = model.ticket !== null;
            expect(save.mock.calls).toEqual(model.calls);
            expect(saveButton() !== null).toBe(
              offered && (model.status === "idle" || model.status === "error")
            );
            expect(saving !== null).toBe(offered && model.status === "saving");
            expect(saved !== null).toBe(offered && model.status === "saved");
            expect(failed !== null).toBe(model.status === "error");
            // One player throughout: the block's own, or the saved
            // artifact's embed (seeded from the save response).
            expect(screen.queryAllByTestId("flow-player")).toHaveLength(1);
            expect(screen.queryByTestId("flow-preview") !== null).toBe(
              offered && model.status === "saved"
            );
          }
        } finally {
          ui.unmount();
          queryClient.clear();
        }
      },
      { testCases: 40 }
    ),
  60_000
);

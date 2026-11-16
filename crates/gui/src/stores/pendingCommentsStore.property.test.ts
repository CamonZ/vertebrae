import { expect, test } from "vitest";
import * as hegel from "@hegeldev/hegel";
import * as gs from "@hegeldev/hegel/generators";
import type { PendingComment } from "../components/ChatWindow/assistantTextComments";
import { usePendingCommentsStore } from "./pendingCommentsStore";

/*
 * Staged comments are keyed by chat scope (session + worktree) so they
 * outlive the chat window (ticket 3845ab6b). Invariants:
 *
 * - Scopes are isolated: an update touches only its own scope.
 * - No scope is stored empty; an emptied scope is removed.
 * - Deleting a conversation drops all its scopes and only those.
 * - An update that changes nothing keeps the state object, so subscribers
 *   of every scope see no change.
 */

// "s10" shares a prefix with "s1": deleting s1 must not touch it.
const SCOPES = ["s1:/w", "s1:/other", "s2:/w", "s10:/w"];

const comment = (id: string): PendingComment => ({
  kind: "text",
  id,
  responseId: "r",
  itemId: null,
  quote: "q",
  contextBefore: "",
  contextAfter: "",
  body: "b",
});

interface Machine {
  model: Map<string, string[]>;
  next: number;
}

const store = () => usePendingCommentsStore.getState();
const ids = (scope: string) =>
  (store().byScope[scope] ?? []).map((staged) => staged.id);

const storeMachine: hegel.stateful.StateMachine<Machine> = {
  rules: {
    stage: (tc, machine) => {
      const scope = tc.draw(gs.sampledFrom(SCOPES));
      const id = `c${machine.next++}`;
      store().update(scope, (comments) => [...comments, comment(id)]);
      machine.model.set(scope, [...(machine.model.get(scope) ?? []), id]);
    },
    remove: (tc, machine) => {
      const scope = tc.draw(gs.sampledFrom(SCOPES));
      const staged = machine.model.get(scope) ?? [];
      tc.assume(staged.length > 0);
      const id = tc.draw(gs.sampledFrom(staged));
      store().update(scope, (comments) =>
        comments.filter((candidate) => candidate.id !== id)
      );
      machine.model.set(
        scope,
        staged.filter((candidate) => candidate !== id)
      );
    },
    send: (tc, machine) => {
      const scope = tc.draw(gs.sampledFrom(SCOPES));
      store().update(scope, () => []);
      machine.model.set(scope, []);
    },
    deleteSession: (tc, machine) => {
      const session = tc.draw(gs.sampledFrom(["s1", "s2", "s10"]));
      store().clearSession(session);
      for (const scope of SCOPES)
        if (scope.split(":")[0] === session) machine.model.set(scope, []);
    },
    unchanged: (tc, machine) => {
      const scope = tc.draw(gs.sampledFrom(SCOPES));
      const before = store();
      // An identity update, or clearing a scope that is already empty.
      const update = tc.draw(gs.sampledFrom(["same", "empty"]));
      if (update === "same") store().update(scope, (comments) => comments);
      else if (!machine.model.get(scope)?.length)
        store().update(scope, () => []);
      expect(store().byScope).toBe(before.byScope);
    },
  },
  invariants: {
    matchesModel: {
      alwaysCheck: true,
      check: (_tc, machine) => {
        for (const scope of SCOPES)
          expect(ids(scope)).toEqual(machine.model.get(scope) ?? []);
        for (const staged of Object.values(store().byScope))
          expect(staged.length).toBeGreaterThan(0);
      },
    },
  },
};

test("staged comments follow a per-scope model through stage, remove and send", () =>
  hegel.test(
    (tc) => {
      usePendingCommentsStore.setState({ byScope: {} });
      hegel.stateful.run(tc, storeMachine, { model: new Map(), next: 0 });
    },
    { testCases: 200 }
  ));

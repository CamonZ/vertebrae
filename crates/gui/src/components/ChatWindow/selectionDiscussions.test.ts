import { describe, expect, it } from "vitest";
import * as hegel from "@hegeldev/hegel";
import * as gs from "@hegeldev/hegel/generators";
import { parsePatch } from "../thread/toolChange/diffLineMapper";
import {
  captureCodeSelection,
  discussionPrompt,
  SelectionDiscussions,
} from "./selectionDiscussions";
import { createDiffComment } from "../thread/toolChange/diffComments";
import { formatTextCommentsForReply } from "./assistantTextComments";

// Expected paths, numbers and snapshots are hand specified, independently of
// the production selection and mapping functions.
const fixtures = [
  {
    patch:
      "diff --git a/src/a.ts b/src/a.ts\n--- a/src/a.ts\n+++ b/src/a.ts\n@@ -4,2 +4,3 @@\n keep\n-old\n+new\n+last\n",
    range: { start: 5, end: 6, side: "additions" as const },
    expected: {
      path: "src/a.ts",
      side: "new",
      startLine: 5,
      endLine: 6,
      code: "new\nlast",
    },
  },
  {
    patch:
      "diff --git a/old.ts b/renamed.ts\nrename from old.ts\nrename to renamed.ts\n--- a/old.ts\n+++ b/renamed.ts\n@@ -9 +9 @@\n-before\n+after\n",
    range: { start: 9, end: 9, side: "additions" as const },
    expected: {
      path: "renamed.ts",
      side: "new",
      startLine: 9,
      endLine: 9,
      code: "after",
    },
  },
  {
    patch:
      "diff --git a/gone.ts b/gone.ts\ndeleted file mode 100644\n--- a/gone.ts\n+++ /dev/null\n@@ -1,2 +0,0 @@\n-one\n-two\n",
    range: { start: 2, end: 1, side: "deletions" as const },
    expected: {
      path: "gone.ts",
      side: "old",
      startLine: 1,
      endLine: 2,
      code: "one\ntwo",
    },
  },
];
const home = {
  kind: "worktree" as const,
  wholeBranch: true,
  comparisonIdentity: "base",
};

function anchor(index = 0) {
  const fixture = fixtures[index];

  const file = parsePatch(fixture.patch)[0];

  return captureCodeSelection(file, fixture.range, home)!;
}

describe("selection context oracle", () => {
  for (const [index, fixture] of fixtures.entries())
    it(`captures exact outbound context ${index}`, () => {
      const selected = anchor(index);

      expect(selected).toMatchObject(fixture.expected);

      const controller = new SelectionDiscussions();

      controller.select(selected);

      const id = controller.ask()!;
      const turn = controller.begin(id, "Explain this")!;
      const prompt = discussionPrompt(turn);
      const contextSection = prompt.split("Context: ")[1];
      const contextJson = contextSection.split("\nConversation:")[0];
      const context = JSON.parse(contextJson);

      expect(context).toEqual({ ...fixture.expected, outdated: false });

      const comment = createDiffComment({
        id: "attachment",
        home,
        file: selected.file,
        span: selected,
        body: "",
      })!;
      const attachment = { ...comment, selectionCode: selected.code };
      const message = formatTextCommentsForReply([attachment], "My question");

      expect(message).toContain(
        `${fixture.expected.path}:${fixture.expected.startLine}${fixture.expected.endLine === fixture.expected.startLine ? "" : `-${fixture.expected.endLine}`} (${fixture.expected.side})`
      );
      expect(message).toContain(
        `Selected code snapshot: ${JSON.stringify(fixture.expected.code)}`
      );
      expect(message).toContain("My question");
    });

  it("retains the original snapshot through edits and follow-ups", () => {
    const controller = new SelectionDiscussions();

    controller.select(anchor());

    const id = controller.ask()!;
    const first = controller.begin(id, "Why?")!;

    controller.receive(id, first.requestId!, "Because", false);
    controller.finish(id, first.requestId!);

    const changedPatch = fixtures[0].patch.replace("+new", "+changed");
    const file = parsePatch(changedPatch)[0];

    controller.reconcile({
      wholeBranch: true,
      comparisonIdentity: "base",
      files: [file],
    });

    const next = controller.begin(id, "Explain more")!;

    expect(next.outdated).toBe(true);
    expect(next.anchor.code).toBe("new\nlast");
    expect(discussionPrompt(next)).toContain('"code":"new\\nlast"');
    expect(next.messages.map((message) => message.text)).toEqual([
      "Why?",
      "Because",
      "Explain more",
    ]);

    controller.cancel(id);
    controller.receive(id, next.requestId!, "late", false);

    const snapshot = controller.getSnapshot();
    const lastMessage = snapshot.threads[0].messages.at(-1)?.text;

    expect(lastMessage).toBe("Explain more");
  });
});

it("generated discussion state machine agrees with an independent observable model", () =>
  hegel.test(
    (tc) => {
      const operationGenerator = gs.integers({ minValue: 0, maxValue: 10 });
      const sequenceGenerator = gs.arrays(operationGenerator, {
        minSize: 1,
        maxSize: 80,
      });
      const sequence = tc.draw(sequenceGenerator);
      let controller = new SelectionDiscussions();
      // Reference model records facts rather than reproducing the reducer or line mapper.
      let selected = false;
      let active: number | null = null;
      let ids: string[] = [];
      let facts: {
        original: string;
        waiting: boolean;
        outdated: boolean;
        text: string[];
        request: string | null;
      }[] = [];
      const oldRequests: {
        controller: SelectionDiscussions;
        id: string;
        request: string;
      }[] = [];
      let replayIndex = 0;

      for (const operation of sequence) {
        if (operation === 0) {
          controller.select(anchor());
          selected = true;
        }

        if (operation === 1) {
          const id = controller.ask();

          if (selected) {
            expect(id).not.toBeNull();

            ids.push(id!);
            facts.push({
              original: "new\nlast",
              waiting: false,
              outdated: false,
              text: [],
              request: null,
            });
            active = facts.length - 1;
          } else expect(id).toBeNull();
        }

        if (operation === 2 && active !== null) {
          const result = controller.begin(ids[active], "question");

          if (facts[active].waiting) expect(result).toBeNull();
          else {
            expect(result).not.toBeNull();

            facts[active].waiting = true;
            facts[active].text.push("question");
            facts[active].request = result!.requestId;
            oldRequests.push({
              controller,
              id: ids[active],
              request: result!.requestId!,
            });
          }
        }

        if (operation === 3 && active !== null) {
          controller.cancel(ids[active]);
          facts[active].waiting = false;
        }

        if (operation === 4 && facts.length) {
          active = 0;
          controller.reopen(ids[0]);
        }

        if (operation === 5) {
          controller.reopen(null);
          active = null;
        }

        if (operation === 6) {
          controller.reconcile({
            wholeBranch: true,
            comparisonIdentity: "changed",
            files: [],
          });
          selected = false;
          facts.forEach((fact) => {
            fact.outdated = true;
          });
        }

        if (operation === 7 || operation === 8) {
          // session or worktree switch retires the whole owner
          controller = new SelectionDiscussions();
          ids = [];
          facts = [];
          active = null;
          selected = false;
        }

        if (operation === 9 && oldRequests.length) {
          const old = oldRequests[replayIndex++ % oldRequests.length];

          old.controller.receive(old.id, old.request, "answer", false);
          old.controller.finish(old.id, old.request);

          const index = ids.indexOf(old.id);

          if (
            old.controller === controller &&
            index >= 0 &&
            facts[index].waiting &&
            facts[index].request === old.request
          ) {
            facts[index].text.push("answer");
            facts[index].waiting = false;
          }
        }

        if (operation === 10)
          expect(controller.getSnapshot().selection).toEqual(
            selected ? anchor() : null
          );

        const state = controller.getSnapshot();

        expect(state.selection !== null).toBe(selected);
        expect(state.activeId).toBe(active === null ? null : ids[active]);
        const observedThreads = state.threads.map((thread) => {
          const text = thread.messages.map((message) => message.text);

          return {
            original: thread.anchor.code,
            waiting: thread.requestId !== null,
            outdated: thread.outdated,
            text,
          };
        });
        const expectedThreads = facts.map((fact) => ({
          original: fact.original,
          waiting: fact.waiting,
          outdated: fact.outdated,
          text: fact.text,
        }));

        expect(observedThreads).toEqual(expectedThreads);
      }
    },
    { seed: 0x0cd1b401 }
  ));

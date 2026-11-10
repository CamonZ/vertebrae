import { describe, expect, it } from "vitest";
import * as hegel from "@hegeldev/hegel";
import * as gs from "@hegeldev/hegel/generators";
import { parsePatch } from "../thread/toolChange/diffLineMapper";
import {
  captureCodeSelection,
  discussionTurn,
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

/** A controller with one thread on `selected`. */
function threadOn(selected = anchor()) {
  const controller = new SelectionDiscussions();

  controller.select(selected);
  const id = controller.ask()!;

  return { controller, id, thread: () => controller.thread(id)! };
}

describe("selection context oracle", () => {
  for (const [index, fixture] of fixtures.entries())
    it(`captures exact outbound context ${index}`, () => {
      const selected = anchor(index);

      expect(selected).toMatchObject(fixture.expected);

      const { thread } = threadOn(selected);
      const turn = discussionTurn(thread(), false, "Explain this");
      const contextSection = turn.payload.split("Context: ")[1];
      const contextJson = contextSection.split("\nQuestion:")[0];
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
});

describe("turn oracle", () => {
  // Literal payloads, written by hand rather than derived from production.
  const first =
    'Context: {"path":"src/a.ts","side":"new","startLine":5,"endLine":6,"code":"new\\nlast","outdated":false}\nQuestion: Please explain what this file does';
  const second = "what does the function below that line do?";
  const third =
    "Note: the selected code has changed since this discussion started, so the original snapshot may be outdated.\n\nIs it still correct?";
  const fourth = "Thanks";
  const edited = {
    wholeBranch: true,
    comparisonIdentity: "base",
    files: [parsePatch(fixtures[0].patch.replace("+new", "+changed"))[0]],
  };

  it("sends the anchor once and only the question on later turns", () => {
    const { controller, id, thread } = threadOn();
    const payloads: string[] = [];
    const turn = (question: string) => {
      const continues = payloads.length > 0;
      const next = discussionTurn(thread(), continues, question);

      controller.sent(id, "session-1", next.notesOutdated);
      payloads.push(next.payload);
    };

    turn("Please explain what this file does");
    turn(second);
    controller.reconcile(edited);
    turn("Is it still correct?");
    turn(fourth);

    expect(payloads).toEqual([first, second, third, fourth]);
    expect(thread().sessionId).toBe("session-1");
  });

  it("a new conversation carries the anchor and its outdated flag", () => {
    const { controller, id, thread } = threadOn();

    controller.reconcile(edited);
    const next = discussionTurn(thread(), false, "Why?");
    controller.sent(id, "session-2", next.notesOutdated);

    expect(next.payload).toContain('"outdated":true');
    expect(next.payload).toContain("Question: Why?");
    // The context said so; follow-ups add no note.
    expect(discussionTurn(thread(), true, "More").payload).toBe("More");
  });
});

it("generated discussion state machine agrees with an independent observable model", () =>
  hegel.test(
    (tc) => {
      const sequence = tc.draw(
        gs.arrays(gs.integers({ minValue: 0, maxValue: 8 }), {
          minSize: 1,
          maxSize: 80,
        })
      );
      let controller = new SelectionDiscussions();
      // Facts only: the model shares no logic with the controller.
      let selected = false;
      let active: number | null = null;
      let ids: string[] = [];
      let facts: {
        outdated: boolean;
        noted: boolean;
        session: string | null;
      }[] = [];

      for (const operation of sequence) {
        if (operation === 0) {
          controller.select(anchor());
          selected = true;
        }

        if (operation === 1) {
          const id = controller.ask();

          if (selected) {
            ids.push(id!);
            facts.push({ outdated: false, noted: false, session: null });
            active = facts.length - 1;
          } else expect(id).toBeNull();
        }

        if ((operation === 2 || operation === 3) && active !== null) {
          // 2 continues the conversation; 3 starts a new one.
          const fact = facts[active];
          const continues = operation === 2 && fact.session !== null;
          const next = discussionTurn(
            controller.thread(ids[active])!,
            continues,
            "question"
          );
          const session = continues ? fact.session! : `session-${active}`;

          controller.sent(ids[active], session, next.notesOutdated);

          if (!continues) {
            expect(next.payload).toContain('"code":"new\\nlast"');
            expect(next.payload).toContain(`"outdated":${fact.outdated}`);
            fact.noted ||= fact.outdated;
          } else if (fact.outdated && !fact.noted) {
            expect(next.payload).toMatch(/^Note: .*\n\nquestion$/);
            fact.noted = true;
          } else expect(next.payload).toBe("question");
          fact.session = session;
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

        if (operation === 7) {
          // A session or worktree switch replaces the whole owner.
          controller = new SelectionDiscussions();
          ids = [];
          facts = [];
          active = null;
          selected = false;
        }

        const state = controller.getSnapshot();

        expect(state.selection !== null).toBe(selected);
        expect(state.activeId).toBe(active === null ? null : ids[active]);
        expect(
          state.threads.map((thread) => ({
            code: thread.anchor.code,
            outdated: thread.outdated,
            noted: thread.outdatedNoted,
            session: thread.sessionId,
          }))
        ).toEqual(
          facts.map((fact) => ({
            code: "new\nlast",
            outdated: fact.outdated,
            noted: fact.noted,
            session: fact.session,
          }))
        );
      }
    },
    { seed: 0x8640ee9e }
  ));

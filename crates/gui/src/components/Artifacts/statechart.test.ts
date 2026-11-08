import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { createActor, createMachine } from "xstate";
import * as hegel from "@hegeldev/hegel";
import * as gs from "@hegeldev/hegel/generators";
import { parseStatechart } from "./statechart";
import { layoutStatechart } from "./statechartLayout";

const doc = readFileSync(
  "../../docs/agent-context/statecharts-example.md",
  "utf8"
);
const documentedMachine = doc.match(/```json\n([\s\S]*?)\n```/)![1];

function topology(body: string) {
  const machine = parseStatechart(body);
  const states = machine.nodes.map((node) => [
    node.id,
    node.parentId,
    node.type,
  ]);
  const transitions = machine.transitions.map((edge) => [
    edge.source,
    edge.event,
    edge.target,
    edge.kind,
  ]);

  return { states, transitions };
}

describe("XState statechart contract", () => {
  it("reads the published XState machine with compound, parallel and final semantics", () => {
    const machine = parseStatechart(documentedMachine);
    const work = machine.nodes.find((node) => node.id === "delivery.Work");
    const verify = machine.nodes.find(
      (node) => node.id === "delivery.Work.Verify"
    );
    const done = machine.nodes.find((node) => node.id === "delivery.Done");
    const edges = machine.transitions.map((edge) => [
      edge.source,
      edge.event,
      edge.target,
    ]);

    expect(machine.name).toBe("Ticket delivery");
    expect(work?.type).toBe("compound");
    expect(work?.initial).toEqual(["delivery.Work.Implement"]);
    expect(verify?.type).toBe("parallel");
    expect(done?.type).toBe("final");
    expect(edges).toEqual([
      ["delivery.Work", "ACCEPT", "delivery.Done"],
      ["delivery.Work.Implement", "READY", "delivery.Work.Verify"],
      ["delivery.Work.Implement", "RETRY", "delivery.Work.Implement"],
      ["delivery.Work.Verify", "CHANGES", "delivery.Work.Implement"],
      ["delivery.Work.Verify", "done", "delivery.Work.Ready"],
      [
        "delivery.Work.Verify.Tests.Running",
        "PASS",
        "delivery.Work.Verify.Tests.Passed",
      ],
      [
        "delivery.Work.Verify.Review.Pending",
        "APPROVE",
        "delivery.Work.Verify.Review.Approved",
      ],
    ]);
  });

  it("the unmodified published config actually activates both regions and completes only when both finish", () => {
    // An independent executable oracle for the documentation. Production only
    // constructs the model; this trusted fixture is the only actor run here.
    const config = JSON.parse(documentedMachine);
    const machine = createMachine(config);
    const actor = createActor(machine);
    actor.start();

    try {
      actor.send({ type: "READY" });

      const verifying = actor.getSnapshot();
      const expected = {
        Work: { Verify: { Tests: "Running", Review: "Pending" } },
      };

      expect(verifying.value).toEqual(expected);

      actor.send({ type: "PASS" });

      const waitingForReview = actor.getSnapshot();
      expect(waitingForReview.matches({ Work: "Verify" })).toBe(true);

      actor.send({ type: "APPROVE" });

      const ready = actor.getSnapshot();
      expect(ready.value).toEqual({ Work: "Ready" });

      actor.send({ type: "ACCEPT" });

      const complete = actor.getSnapshot();
      expect(complete.value).toBe("Done");
      expect(complete.status).toBe("done");
    } finally {
      actor.stop();
    }
  });

  it("lays out the real native viewer without losing nested states, endpoints or initials", async () => {
    const machine = parseStatechart(documentedMachine);
    const layout = await layoutStatechart(machine);
    const renderedIds = layout.states.map((node) => node.id).sort();
    const expectedIds = machine.nodes.map((node) => node.id).sort();
    const events = layout.transitions.filter((edge) => !edge.initial);
    const initials = layout.transitions.filter((edge) => edge.initial);

    expect(renderedIds).toEqual(expectedIds);
    expect(events).toHaveLength(7);
    expect(initials).toHaveLength(4);

    for (const edge of layout.transitions) {
      const target = layout.states.find((node) => node.id === edge.target)!;
      const endpoint = edge.points[edge.points.length - 1];
      const withinX =
        endpoint.x >= target.x - 1 && endpoint.x <= target.x + target.width + 1;
      const withinY =
        endpoint.y >= target.y - 1 &&
        endpoint.y <= target.y + target.height + 1;

      expect(withinX && withinY, edge.id).toBe(true);
    }

    for (const node of layout.states) {
      if (!node.parentId) continue;

      const parent = layout.states.find(
        (candidate) => candidate.id === node.parentId
      )!;

      expect(node.x).toBeGreaterThanOrEqual(parent.x);
      expect(node.y).toBeGreaterThanOrEqual(parent.y);
      expect(node.x + node.width).toBeLessThanOrEqual(parent.x + parent.width);
      expect(node.y + node.height).toBeLessThanOrEqual(
        parent.y + parent.height
      );
    }
  });

  it("preserves independent generated topology under ID renaming, declaration reordering and description edits", () =>
    hegel.test((tc) => {
      const sizeGenerator = gs.integers({ minValue: 1, maxValue: 10 });
      const count = tc.draw(sizeGenerator);
      const fromGenerator = gs.integers({ minValue: 0, maxValue: count - 1 });
      const toGenerator = gs.integers({ minValue: 0, maxValue: count - 1 });
      const edgeGenerator = gs.record({ from: fromGenerator, to: toGenerator });
      const edgesGenerator = gs.arrays(edgeGenerator, { maxSize: 20 });
      const pairs = tc.draw(edgesGenerator);
      const parallelGenerator = gs.booleans();
      const parallel = tc.draw(parallelGenerator);

      function check(prefix: string, reverse: boolean, description: string) {
        const leaves: Record<string, unknown> = {};
        const order = Array.from({ length: count }, (_, index) => index);

        if (reverse) order.reverse();

        for (const index of order) {
          const on: Record<string, string> = {};

          pairs.forEach((pair, eventIndex) => {
            if (pair.from === index)
              on[`E${eventIndex}`] = `#${prefix}${pair.to}`;
          });

          leaves[`s${index}`] = { id: `${prefix}${index}`, description, on };
        }

        const group = { initial: "s0", states: leaves };
        const root = parallel
          ? {
              id: "machine",
              type: "parallel",
              states: {
                region: group,
                other: { initial: "idle", states: { idle: {} } },
              },
            }
          : { id: "machine", initial: "group", states: { group } };
        const body = JSON.stringify(root);
        const machine = parseStatechart(body);
        const actual = machine.transitions
          .map((edge) => `${edge.source}/${edge.event}/${edge.target}`)
          .sort();
        const expected = pairs
          .map(
            (pair, index) =>
              `${prefix}${pair.from}/E${index}/${prefix}${pair.to}`
          )
          .sort();

        expect(actual).toEqual(expected);
        expect(
          machine.nodes.filter((node) => node.id.startsWith(prefix))
        ).toHaveLength(count);

        return actual;
      }

      const original = check("a", false, "Original");
      const edited = check("a", true, "Changed description");

      expect(edited).toEqual(original);
      check("renamed", true, "Changed description");
    }));

  it("diagnoses generated unsupported behavior without silently dropping it", () =>
    hegel.test((tc) => {
      const fieldGenerator = gs.sampledFrom([
        "entry",
        "exit",
        "actions",
        "invoke",
        "context",
        "version",
        "transitions",
      ]);
      const field = tc.draw(fieldGenerator);
      const definition = JSON.parse(documentedMachine);
      const unsupported = { ...definition, [field]: "untrusted behavior" };
      const body = JSON.stringify(unsupported);
      const parseInvalid = () => parseStatechart(body);

      expect(parseInvalid).toThrow(`Unsupported XState field: ${field}`);
    }));

  it("uses XState target resolution for siblings, descendants and explicit IDs", async () => {
    const config = {
      id: "sample",
      initial: "group",
      states: {
        group: {
          initial: "a",
          on: { RESET: ".a" },
          states: {
            a: { on: { NEXT: "b" } },
            b: {
              id: "specific",
              on: {
                HOME: "#sample.group.a",
                SELF: { target: "#specific", reenter: true },
                LOG: {},
              },
            },
          },
        },
      },
    };
    const body = JSON.stringify(config);
    const machine = parseStatechart(body);
    const edges = machine.transitions.map((edge) => [
      edge.event,
      edge.target,
      edge.kind,
      edge.reenter,
    ]);

    expect(edges).toEqual([
      ["RESET", "sample.group.a", "event", false],
      ["NEXT", "specific", "event", false],
      ["HOME", "sample.group.a", "event", false],
      ["SELF", "specific", "event", true],
      ["LOG", "specific", "internal", false],
    ]);

    const layout = await layoutStatechart(machine);
    const events = layout.transitions.filter((edge) => !edge.initial);

    expect(events).toHaveLength(5);
  });

  it.each([
    null,
    [],
    { version: 1, name: "old graph", states: [] },
    { id: "bad", initial: "absent", states: { idle: {} } },
    { id: "bad", initial: "idle", states: { idle: { on: { GO: "missing" } } } },
    {
      id: "bad",
      initial: "idle",
      states: { idle: { invoke: { src: "untrusted" } } },
    },
    { id: "bad", initial: "idle", states: { idle: { entry: "execute" } } },
    { id: "bad", initial: "idle", states: { idle: { type: "history" } } },
    {
      id: "bad",
      initial: "idle",
      states: { idle: { type: "final", on: { GO: "idle" } } },
    },
    { id: "bad", type: "parallel", initial: "idle", states: { idle: {} } },
    {
      id: "bad",
      initial: "idle",
      states: { idle: { on: { GO: { target: ["idle"] } } } },
    },
    {
      id: "bad",
      initial: "a",
      states: { a: { id: "duplicate" }, b: { id: "duplicate" } },
    },
    { id: "bad", initial: "a", states: { a: { id: "bad.b" }, b: {} } },
  ])("diagnoses malformed or unsupported configuration (%#)", (definition) => {
    const body = JSON.stringify(definition);
    const parseInvalid = () => parseStatechart(body);

    expect(parseInvalid).toThrow();
  });

  it("bounds oversized input and treats text as data", () => {
    const oversized = " ".repeat(100_001);
    const parseOversized = () => parseStatechart(oversized);

    expect(parseOversized).toThrow("100,000");

    const config = {
      id: "safe",
      initial: "idle",
      description: '<script>alert("x")</script>',
      states: { idle: {} },
    };
    const body = JSON.stringify(config);
    const machine = parseStatechart(body);

    const parsedTopology = topology(body);

    expect(machine.name).toBe(config.description);
    expect(parsedTopology.states).toHaveLength(2);
  });
});

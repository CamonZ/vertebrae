/**
 * Model-based test of `useLaidOutFlow`. A Hegel state machine swaps the
 * hook's input between specs that need auto-layout, fully hand-placed specs
 * and invalid ones, lets random slices of time pass while ELK is still
 * running, and waits for layouts to settle. The model is the result of
 * compiling the current input on its own: whenever the hook says "done" it
 * must show exactly that (never a layout of an earlier input), it is pending
 * only while the current input waits for ELK, and it always settles.
 */
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, expect, test } from "vitest";
import * as hegel from "@hegeldev/hegel";
import * as gs from "@hegeldev/hegel/generators";
import burstOptions from "./__fixtures__/burstOptions.flow.yaml?raw";
import inlineDiscussions from "./__fixtures__/inlineDiscussions.flow.yaml?raw";
import {
  compileFlow,
  compileFlowLaidOut,
  needsAutoLayout,
  parseFlowSpec,
  type CompileResult,
  type FlowSpec,
  type PartSpec,
} from "./index";
import { useLaidOutFlow, type LaidOutFlowState } from "./useLaidOutFlow";

afterEach(cleanup);

function check(condition: boolean, message: string): void {
  if (!condition) throw new Error(message);
}

function load(source: string): FlowSpec {
  const parsed = parseFlowSpec(source);
  if (!parsed.ok) throw new Error("fixture does not parse");
  return parsed.value as FlowSpec;
}
const placed = load(inlineDiscussions);

const unplace = (p: PartSpec): PartSpec => {
  const q = { ...p };
  delete (q as { position?: unknown }).position;
  return q;
};

/** Stable inputs, as a caller that memoizes its parse would pass them. */
const INPUTS: readonly { name: string; input: unknown }[] = [
  { name: "hand-placed", input: placed },
  { name: "unplaced", input: { ...placed, parts: placed.parts.map(unplace) } },
  {
    name: "half-placed",
    input: {
      ...placed,
      parts: placed.parts.map((p, i) => (i % 2 ? unplace(p) : p)),
    },
  },
  {
    name: "branch",
    input: {
      version: 1,
      parts: [
        { id: "src", kind: "source" },
        { id: "gate", kind: "guard" },
        { id: "ok", kind: "worker" },
        { id: "no", kind: "store" },
      ],
      rails: [
        { id: "a", from: "src.out", to: "gate.in" },
        { id: "b", from: "gate.allow", to: "ok.in" },
        { id: "c", from: "gate.deny", to: "no.in", label: "deny" },
      ],
    },
  },
  { name: "three options (named arrangements)", input: load(burstOptions) },
  {
    name: "invalid",
    input: { version: 1, parts: [{ id: "a", kind: "no-such-part" }] },
  },
];

/** What each input compiles to on its own: the model. */
const EXPECTED: CompileResult[] = await Promise.all(
  INPUTS.map(({ input }) => compileFlowLaidOut(input))
);
const NEEDS = INPUTS.map(({ input }) => {
  const r = compileFlow(input);
  return r.ok && needsAutoLayout(r.flow);
});

interface Machine {
  hook: {
    result: { current: LaidOutFlowState };
    rerender: (p: { input: unknown }) => void;
  };
  at: number;
}

const name = (m: Machine) => INPUTS[m.at].name;

function showsCurrent(m: Machine) {
  const s = m.hook.result.current;
  if (!NEEDS[m.at])
    check(
      s.status === "done",
      `${name(m)} needs no layout but the hook is pending`
    );
  if (s.status === "done") expect(s.result).toEqual(EXPECTED[m.at]);
}

const machine: hegel.stateful.StateMachine<Machine> = {
  rules: {
    show(tc, m) {
      const at = tc.draw(
        gs.integers({ minValue: 0, maxValue: INPUTS.length - 1 })
      );
      const changed = at !== m.at;
      m.at = at;
      act(() => m.hook.rerender({ input: INPUTS[at].input }));
      if (changed && NEEDS[at])
        check(
          m.hook.result.current.status === "pending",
          `switching to ${name(m)} showed a picture before its layout`
        );
    },
    async wait(tc) {
      const ms = tc.draw(gs.integers({ minValue: 0, maxValue: 15 }));
      await act(() => new Promise((r) => setTimeout(r, ms)));
    },
    async settle(_tc, m) {
      await waitFor(() => expect(m.hook.result.current.status).toBe("done"), {
        timeout: 10_000,
      });
    },
  },
  invariants: {
    showsCurrent: { check: (_tc, m) => showsCurrent(m), alwaysCheck: true },
  },
};

test(
  "the hook shows the current input's layout, never a stale one",
  () =>
    hegel.testAsync(
      async (tc) => {
        const at = tc.draw(
          gs.integers({ minValue: 0, maxValue: INPUTS.length - 1 })
        );
        const hook = renderHook(
          ({ input }: { input: unknown }) => useLaidOutFlow(input),
          { initialProps: { input: INPUTS[at].input } }
        );
        const m: Machine = { hook, at };
        try {
          await hegel.stateful.runAsync(tc, machine, m, { stepCount: 20 });
          await machine.rules.settle(tc, m);
          showsCurrent(m);
        } finally {
          hook.unmount();
        }
      },
      { testCases: 30 }
    ),
  120_000
);

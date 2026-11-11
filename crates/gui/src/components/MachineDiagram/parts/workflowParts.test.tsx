/**
 * Vertebrae workflow parts (inference step, structured step, execute step,
 * route step, wait children, human gate, run end, task run) in a ```flow
 * spec: every kind is chosen by step type, compiles, and writes the
 * catalogue status lines.
 */
import { describe, expect, it } from "vitest";
import { arrangement, compileFlow } from "../flow/compile";
import { createFlowRegistry } from "../flow/defaults";
import { parseFlowSpec } from "../flow/parse";
import { validateFlowSpec } from "../flow/validate";

function compile(source: string) {
  const parsed = parseFlowSpec(source);
  if (!parsed.ok) throw new Error(JSON.stringify(parsed));
  expect(validateFlowSpec(parsed.value, createFlowRegistry())).toEqual([]);
  const result = compileFlow(parsed.value);
  if (!result.ok) throw new Error(JSON.stringify(result.errors));
  return arrangement(result.flow, "current")!;
}

const notes = (d: ReturnType<typeof compile>, id: string) =>
  d.parts.find((p) => p.id === id)!.timeline.notes.map((n) => n[1]);

const WORKFLOWS = `
version: 1
parts:
  - { id: run, kind: task run }
  - { id: llm, kind: inference step }
  - { id: ask, kind: structured step }
  - { id: scr, kind: execute step }
  - { id: pick, kind: route step }
  - { id: kids, kind: wait children }
  - { id: gate, kind: human gate }
  - { id: end, kind: run end }
cards:
  - { id: r, token: payload, label: run }
  - { id: p, token: payload, label: prompt }
  - { id: s, token: payload, label: state }
  - { id: c, token: payload, label: context }
  - { id: o, token: payload, label: output }
  - { id: pr, token: payload, label: parent }
  - { id: q, token: payload, label: question }
  - { id: f, token: payload, label: run 1 }
  - { id: g, token: payload, label: run 2 }
story:
  - caption: a run goes through its steps, parks at a gate and completes
    steps:
      - { verb: start, part: run, card: r }
      - { verb: stage, part: run }
      - { verb: wait, part: run }
      - { verb: stage, part: run }
      - { verb: finish, part: run }
  - caption: an agent turn calls a tool and its output fits the schema
    steps:
      - { verb: stage, part: llm, card: p }
      - { verb: call, part: llm, args: { tool: edit } }
      - { verb: validate, part: llm }
      - { verb: finish, part: llm, card: p }
  - caption: typed questions are answered and checked
    steps:
      - { verb: ask, part: ask, card: s }
      - { verb: validate, part: ask, args: { outcome: invalid, question: 3 } }
      - { verb: fail, part: ask }
  - caption: a script calls the host and a route picks the default
    steps:
      - { verb: call, part: scr, args: { host: cmd, op: run } }
      - { verb: transform, part: scr, card: c }
      - { verb: route, part: pick, card: o, args: { rule: else } }
  - caption: a parent waits for its children and a person answers
    steps:
      - { verb: spawn, part: kids, card: pr }
      - { verb: wait, part: kids, args: { child: 1 } }
      - { verb: wait, part: kids, args: { child: 2 } }
      - { verb: wait, part: kids, args: { child: 3 } }
      - { verb: join, part: kids }
      - { verb: validate, part: kids }
      - { verb: wait, part: gate, card: q }
      - { verb: answer, part: gate }
      - { verb: validate, part: gate, card: q }
  - caption: a run stops at a stop step and the next TaskRun continues
    steps:
      - { verb: stop, part: end, card: f }
      - { verb: resume, part: end, card: g }
`;

describe("vertebrae workflow parts in a flow spec", () => {
  it("compiles a spec using every workflow part kind with the catalogue status lines", () => {
    const d = compile(WORKFLOWS);
    expect(notes(d, "run")).toEqual(
      expect.arrayContaining([
        "queued",
        "executing · llm",
        "executing · execute",
        "waiting · execute",
        "completed",
      ])
    );
    expect(notes(d, "llm")).toEqual(
      expect.arrayContaining([
        "prompt in · claude",
        "agent working",
        "tool call · edit",
        "done · output fits schema",
      ])
    );
    expect(notes(d, "ask")).toEqual(
      expect.arrayContaining([
        "state + questions in",
        "asking · typesafe",
        "3 of 3 answered",
        "q3 not in its enum · step failed",
      ])
    );
    expect(notes(d, "scr")).toEqual(
      expect.arrayContaining([
        "vtb::cmd · run",
        "context in",
        "running script",
        "output valid · step done",
      ])
    );
    expect(notes(d, "pick")).toEqual(
      expect.arrayContaining(["r1 no", "r2 no", "default → plan"])
    );
    expect(notes(d, "kids")).toEqual(
      expect.arrayContaining([
        "3 children forked",
        "1 of 3 done",
        "3 of 3 done",
        "combined output fits · step done",
      ])
    );
    expect(notes(d, "gate")).toEqual(
      expect.arrayContaining([
        "waiting · reviewer",
        "answer.md attached",
        "answer fits · run resumes",
      ])
    );
    expect(notes(d, "end")).toEqual(
      expect.arrayContaining([
        "run 1 at stop step",
        "run 1 stopped · task open",
        "next TaskRun starts",
      ])
    );
  });
});

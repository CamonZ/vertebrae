import { describe, expect, it } from "vitest";
import type { Fact } from "../../../bindings";
import {
  factSections,
  factText,
  orderFacts,
} from "./semanticFacts";

const added = (subject: string) => ({ kind: "added" as const, subject });
const call = (subject: string): Fact => ({ kind: { type: "call" }, change: added(subject) });
const literal: Fact = {
  kind: { type: "literal" },
  change: { kind: "changed", from: "1", to: "2" },
};
const write: Fact = {
  kind: { type: "effect", effect: "filesystem" },
  change: added("std::fs::write"),
};
const lock: Fact = { kind: { type: "lock" }, change: added("state.lock") };
const throwing: Fact = { kind: { type: "throw" }, change: added("panic") };
const exported: Fact = { kind: { type: "visibility" }, change: added("pub") };
const branch: Fact = { kind: { type: "branch" }, change: added("x > 1") };

describe("semantic facts", () => {
  it("orders effects, concurrency, errors, API, control flow, calls, data", () => {
    expect(orderFacts([literal, call("a"), branch, exported, throwing, lock, write])).toEqual([
      write,
      lock,
      throwing,
      exported,
      branch,
      call("a"),
      literal,
    ]);
  });

  it("words each fact kind and change", () => {
    const fact = (kind: Fact["kind"], change: Fact["change"]): Fact => ({ kind, change });
    expect(
      factText(fact({ type: "branch" }, { kind: "changed", from: "x > 1", to: "x > 2" }))
    ).toBe("if x > 1 → x > 2");
    expect(factText(fact({ type: "branch" }, added("else")))).toBe("+ else");
    expect(factText(fact({ type: "call" }, { kind: "removed", subject: "log" }))).toBe(
      "− calls log"
    );
    expect(factText(write)).toBe("+ fs std::fs::write");
    expect(factText(fact({ type: "unwrap" }, added("!")))).toBe("+ non-null !");
    const long = "a".repeat(60);
    expect(factText(call(long))).toBe(`+ calls ${long}`);
  });

  it("lists every fact by declaration and category, uncut", () => {
    const long = "b".repeat(60);
    expect(
      factSections([
        { owner: { keyword: "fn", name: "a" }, whole: true, facts: [call(long), write], omitted: 2 },
      ])
    ).toEqual([
      {
        owner: { keyword: "fn", name: "a" },
        categories: [
          { name: "Effects", facts: ["+ fs std::fs::write"] },
          { name: "Calls", facts: [`+ calls ${long}`] },
        ],
        omitted: 2,
      },
    ]);
  });
});

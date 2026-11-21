/** Formats semantic facts for the disclosure below a change label. */
import type { EffectKind, Fact, FactKind } from "../../../bindings";

export type FactCategory =
  | "effects"
  | "concurrency"
  | "error_handling"
  | "api"
  | "control_flow"
  | "calls"
  | "data"
  | "test";

export const CATEGORY_ORDER: readonly FactCategory[] = [
  "effects",
  "concurrency",
  "error_handling",
  "api",
  "control_flow",
  "calls",
  "data",
  "test",
];

const CATEGORY_NAMES: Record<FactCategory, string> = {
  effects: "Effects",
  concurrency: "Concurrency",
  error_handling: "Error handling",
  api: "API",
  control_flow: "Control flow",
  calls: "Calls",
  data: "Data",
  test: "Test",
};

export function categoryOf(kind: FactKind): FactCategory {
  switch (kind.type) {
    case "effect":
      return "effects";
    case "spawn":
    case "lock":
    case "async":
    case "await":
      return "concurrency";
    case "propagation":
    case "unwrap":
    case "catch":
    case "throw":
    case "error_type":
      return "error_handling";
    case "visibility":
    case "signature":
      return "api";
    case "branch":
    case "match_arm":
    case "early_return":
    case "loop":
      return "control_flow";
    case "call":
      return "calls";
    case "literal":
    case "field":
    case "type_annotation":
      return "data";
    case "test_code":
      return "test";
  }
}

/** A declaration named in a fact group, e.g. `fn diff`. */
export interface FactOwner {
  keyword: string;
  name: string;
}

/**
 * The facts for one declaration. `whole` identifies its addition or removal.
 */
export interface FactGroup {
  owner: FactOwner | null;
  whole: boolean;
  facts: readonly Fact[];
  /** Facts the engine left out of a long list. */
  omitted: number;
}

const rank = (category: FactCategory) => CATEGORY_ORDER.indexOf(category);

/** Facts by category order; stable within one. */
export function orderFacts(facts: readonly Fact[]): Fact[] {
  return facts
    .map((fact, index) => ({ fact, index }))
    .sort(
      (a, b) =>
        rank(categoryOf(a.fact.kind)) - rank(categoryOf(b.fact.kind)) || a.index - b.index
    )
    .map(({ fact }) => fact);
}

const EFFECT_WORDS: Record<EffectKind, string> = {
  filesystem: "fs",
  network: "network",
  process: "process",
  database: "db",
  ipc_command: "ipc",
  event: "event",
  env: "env",
  ui: "ui",
};

/**
 * What a fact is about, as a phrase: `calls retry`, `fs std::fs::write`,
 * `if x > 1`, `early return`. `subject` is the source detail.
 */
function factPhrase(kind: FactKind, subject: string): string {
  switch (kind.type) {
    case "call":
      return `calls ${subject}`;
    case "effect":
      return `${EFFECT_WORDS[kind.effect]} ${subject}`;
    case "branch":
      return subject === "else" ? "else" : `if ${subject}`;
    case "match_arm":
      return `arm ${subject}`;
    case "loop":
      return `loop ${subject}`;
    case "early_return":
      return "early return";
    case "propagation":
      return "error propagation ?";
    case "unwrap":
      return subject === "!" ? "non-null !" : subject;
    case "catch":
    case "throw":
    case "visibility":
      return subject;
    case "error_type":
      return `error type ${subject}`;
    case "literal":
      return `literal ${subject}`;
    case "field":
      return `field ${subject}`;
    case "type_annotation":
      return `type ${subject}`;
    case "signature":
      return `public signature ${subject}`;
    case "async":
      return "async";
    case "await":
      return "await";
    case "spawn":
      return `spawn ${subject}`;
    case "lock":
      return `lock ${subject}`;
    case "test_code":
      return "test code";
  }
}

/**
 * One fact as words, e.g. `+ calls retry`, `− fs fs::write`,
 * `if x > 1 → x > 2`.
 */
export function factText(fact: Fact): string {
  const { change, kind } = fact;
  switch (change.kind) {
    case "added":
      return `+ ${factPhrase(kind, change.subject)}`;
    case "removed":
      return `− ${factPhrase(kind, change.subject)}`;
    case "changed":
      return `${factPhrase(kind, change.from)} → ${change.to}`;
    case "inside":
      return factPhrase(kind, "");
  }
}

/** The same fact, compared by its full text. */
export const factKey = factText;

export interface FactSection {
  owner: FactOwner | null;
  categories: { name: string; facts: string[] }[];
  omitted: number;
}

/** Every fact of a label, uncut, by declaration and then category. */
export function factSections(groups: readonly FactGroup[]): FactSection[] {
  return groups.map((group) => {
    const byCategory = new Map<FactCategory, string[]>();
    for (const fact of orderFacts(group.facts)) {
      const category = categoryOf(fact.kind);
      const list = byCategory.get(category) ?? [];
      list.push(factText(fact));
      byCategory.set(category, list);
    }
    return {
      owner: group.owner,
      categories: [...byCategory].map(([category, facts]) => ({
        name: CATEGORY_NAMES[category],
        facts,
      })),
      omitted: group.omitted,
    };
  });
}

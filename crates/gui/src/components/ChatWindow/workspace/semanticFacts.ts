/**
 * How a semantic label presents the engine's facts about the code its
 * changes touch.
 *
 * - One row of chips, ordered effects, concurrency, error handling, API,
 *   control flow, calls, data.
 * - Edits inside an existing declaration name each fact (`+ calls retry`,
 *   `if x > 1 → x > 2`).
 * - A declaration added or removed whole names only the signal categories
 *   (effects, concurrency, error handling, API) and counts the rest
 *   (`12 calls`).
 * - Chips past a limit fold into a `+N more` button whose panel lists
 *   every fact by declaration and category.
 *
 * No React imports.
 */
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

/** Categories named on an added or removed declaration's label. */
const SIGNAL: ReadonlySet<FactCategory> = new Set([
  "effects",
  "concurrency",
  "error_handling",
  "api",
]);

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
 * The facts one label shows for one declaration. `whole` when the
 * declaration itself was added or removed, so only its signal is named.
 */
export interface FactGroup {
  owner: FactOwner | null;
  whole: boolean;
  facts: readonly Fact[];
  /** Facts the engine left out of a long list. */
  omitted: number;
}

/** Fact chips shown on a label before the rest fold into `+N more`. */
export const MAX_FACT_CHIPS = 4;

export type FactChip =
  | { kind: "fact"; fact: Fact }
  | { kind: "count"; category: FactCategory; count: number };

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

/**
 * A label's chips: named facts (at most `max`), then counts of the
 * categories an added or removed declaration does not name. `hidden`
 * counts the facts not shown, which the `+N more` button lists.
 */
export function factChips(
  groups: readonly FactGroup[],
  max = MAX_FACT_CHIPS
): { chips: FactChip[]; hidden: number } {
  const named: Fact[] = [];
  const counts = new Map<FactCategory, number>();
  let omitted = 0;
  for (const group of groups) {
    omitted += group.omitted;
    for (const fact of group.facts) {
      const category = categoryOf(fact.kind);
      if (group.whole && !SIGNAL.has(category))
        counts.set(category, (counts.get(category) ?? 0) + 1);
      else named.push(fact);
    }
  }
  const ordered = orderFacts(named);
  const shown = ordered.slice(0, max);
  const countChips = [...counts]
    .sort(([a], [b]) => rank(a) - rank(b))
    .map(([category, count]): FactChip => ({ kind: "count", category, count }));
  return {
    chips: [...shown.map((fact): FactChip => ({ kind: "fact", fact })), ...countChips],
    hidden: ordered.length - shown.length + omitted,
  };
}

const COUNT_WORDS: Record<FactCategory, [string, string]> = {
  effects: ["effect", "effects"],
  concurrency: ["concurrency fact", "concurrency facts"],
  error_handling: ["error fact", "error facts"],
  api: ["API fact", "API facts"],
  control_flow: ["control flow", "control flow"],
  calls: ["call", "calls"],
  data: ["data", "data"],
  test: ["test", "test"],
};

export function countText(category: FactCategory, count: number): string {
  const [one, many] = COUNT_WORDS[category];
  return `${count} ${count === 1 ? one : many}`;
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

/** Subjects longer than this are cut on chips (the panel shows them whole). */
const CHIP_SUBJECT = 32;

const clip = (text: string, max: number) =>
  text.length > max ? `${text.slice(0, max - 1)}…` : text;

/**
 * What a fact is about, as a phrase: `calls retry`, `fs std::fs::write`,
 * `if x > 1`, `early return`. `subject` is the (possibly clipped) name.
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
 * `if x > 1 → x > 2`; subjects are cut to `max` characters.
 */
export function factText(fact: Fact, max = CHIP_SUBJECT): string {
  const { change, kind } = fact;
  switch (change.kind) {
    case "added":
      return `+ ${factPhrase(kind, clip(change.subject, max))}`;
    case "removed":
      return `− ${factPhrase(kind, clip(change.subject, max))}`;
    case "changed":
      return `${factPhrase(kind, clip(change.from, max))} → ${clip(change.to, max)}`;
    case "inside":
      return factPhrase(kind, "");
  }
}

/** The same fact, compared by its full text. */
export const factKey = (fact: Fact) => factText(fact, Infinity);

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
      list.push(factText(fact, Infinity));
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

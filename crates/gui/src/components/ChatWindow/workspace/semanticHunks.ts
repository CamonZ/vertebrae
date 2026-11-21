/**
 * Semantic mode for one file in Changes: which unchanged lines to reveal so
 * each hunk opens at its enclosing declaration, which hunks of one
 * declaration to join, and which labels to show. Built on the file's line
 * patch, so line numbers, selections and comment anchors are those of the
 * line diff; semantic mode only reveals lines and adds labels.
 *
 * Coverage: every changed block of the patch is either labelled with the
 * changes that overlap it, marked formatting-only (its text differs only in
 * whitespace), or left as is (a line-diff alignment with no syntax change).
 * Nothing changed is ever hidden.
 *
 * Each label also carries the engine's facts about what kind of code its
 * changes touch, grouped by declaration (`semanticFacts.ts` presents
 * them); test code marks the label instead.
 *
 * No React or Pierre runtime imports.
 */
import type {
  DeclarationDiff,
  Facts,
  LineSpan,
  Occurrence,
  ScopeSegment,
} from "../../../bindings";
import { factKey, orderFacts, type FactGroup } from "./semanticFacts";
import type { GapReveal } from "../../thread/toolChange/diffGaps";
import type {
  FilePatch,
  HunkRow,
} from "../../thread/toolChange/diffLineMapper";
import type { LineDiffReason } from "./useChangeFiles";

/**
 * Lines revealed at most to reach a declaration's opening line, or to join
 * two hunks of one declaration. A farther declaration is named in the label
 * rather than shown.
 */
export const MAX_REVEAL = 40;

export type DiffSide = "deletions" | "additions";

/** A declaration named on a chip, e.g. `fn reset`. */
export interface Declared {
  keyword: string;
  name: string;
}

/**
 * One fact shown on a label. `declaration` is set when the declaration
 * itself was added, removed, renamed or moved.
 */
export type SemanticChip =
  | { kind: "added" | "removed"; declaration: Declared | null }
  | { kind: "changed" | "signature" | "formatting" }
  | { kind: "renamed"; from: string; to: string; sites: number; declaration: Declared | null }
  /** `direction` is where the other copy is: moved from / moved to `line`. */
  | {
      kind: "moved";
      direction: "from" | "to";
      line: number;
      side: DiffSide;
      declaration: Declared | null;
    };

/** The declarations a file adds, removes, renames and moves. */
export interface DeclarationSummary {
  added: readonly Declared[];
  removed: readonly Declared[];
  renamed: readonly { keyword: string; from: string; to: string }[];
  moved: readonly Declared[];
}

export interface SemanticLabel {
  side: DiffSide;
  lineNumber: number;
  declarationIndices?: readonly number[];
  /** The patch itself fits on one line per side. */
  singleLine?: boolean;
  /** This label sits inside the declaration rather than on its header. */
  inScope?: boolean;
  /** Enclosing declarations, outermost first. */
  scope: readonly ScopeSegment[];
  chips: readonly SemanticChip[];
  /** What kind of code the changes touch, per declaration. */
  facts: readonly FactGroup[];
  /** The changes are in test code. */
  test: boolean;
}

/** Structural information worth showing when the reviewer opens a line. */
export function labelChips(label: SemanticLabel): readonly SemanticChip[] {
  return label.chips.filter((chip) => {
    switch (chip.kind) {
      case "changed":
      case "formatting":
        return false;
      case "added":
      case "removed":
        return chip.declaration !== null && !label.singleLine;
      default:
        return true;
    }
  });
}

export interface SemanticHunks {
  /** Per gap index (gap `i` sits above hunk `i`): lines to reveal. */
  reveals: ReadonlyMap<number, GapReveal>;
  labels: readonly SemanticLabel[];
  /** No syntax change: every changed line differs only in whitespace. */
  formattingOnly: boolean;
  summary: DeclarationSummary;
}

/**
 * One thing a declaration reports, where it is: its change to all of it,
 * or one change inside it. `home` is the declaration a label for it sits
 * in: around the declaration for a change to all of it, else the
 * declaration itself.
 */
interface Located {
  /** Null for an added or removed declaration, which is labelled alone. */
  chip: SemanticChip | null;
  old: LineSpan | null;
  new: LineSpan | null;
  sites: readonly Occurrence[];
  home: readonly ScopeSegment[];
  /** Blocks sharing a key describe one declaration. */
  key: string;
  declarationIndex: number;
  facts: Facts;
  /** The declaration the facts are about. */
  owner: Declared | null;
  header: ScopeSegment | null;
}

interface Block {
  hunk: number;
  rows: HunkRow[];
  oldLines: number[];
  newLines: number[];
  located: Located[];
}

const isMember = (subject: ScopeSegment | null) =>
  subject?.kind === "field" || subject?.kind === "variant";

const named = (segment: ScopeSegment): Declared => ({
  keyword: segment.keyword,
  name: segment.name,
});

function locate(declarations: readonly DeclarationDiff[]): Located[] {
  return declarations.flatMap((declaration, index): Located[] => {
    const { scope, subject, change } = declaration;
    const inside = subject ? [...scope, subject] : scope;
    const self = subject && named(subject);
    const out: Located[] = [];
    const whole = (
      chip: SemanticChip | null,
      old: LineSpan | null,
      next: LineSpan | null,
      sites: readonly Occurrence[] = []
    ) =>
      out.push({
        chip,
        old,
        new: next,
        sites,
        home: scope,
        key: `${index}`,
        declarationIndex: index,
        facts: declaration.facts,
        owner: self,
        header: subject,
      });
    switch (change.kind) {
      case "added":
        whole(null, null, change.new);
        break;
      case "removed":
        whole(null, change.old, null);
        break;
      case "moved":
        // The chip's direction is set per copy (see `semanticHunks`).
        whole(
          {
            kind: "moved",
            direction: "from",
            line: 0,
            side: "deletions",
            declaration: self,
          },
          change.old,
          change.new
        );
        break;
      case "renamed":
        whole(
          {
            kind: "renamed",
            from: change.from,
            to: change.to,
            sites: change.sites.length,
            declaration: self,
          },
          change.old,
          change.new,
          change.sites
        );
        break;
      case "modified":
        break;
    }
    for (const part of declaration.parts) {
      const at = (
        chip: SemanticChip,
        old: LineSpan | null,
        next: LineSpan | null,
        sites: readonly Occurrence[] = []
      ) =>
        out.push({
          chip,
          old,
          new: next,
          sites,
          home: inside,
          key: `${index}/`,
          declarationIndex: index,
          facts: part.facts,
          owner: self,
          header: subject,
        });
      switch (part.kind) {
        case "added":
          at({ kind: "added", declaration: null }, null, part.new);
          break;
        case "removed":
          at({ kind: "removed", declaration: null }, part.old, null);
          break;
        case "changed":
          at({ kind: "changed" }, part.old, part.new);
          break;
        case "signature":
          at({ kind: "signature" }, part.old, part.new);
          break;
        case "moved":
          at(
            {
              kind: "moved",
              direction: "from",
              line: 0,
              side: "deletions",
              declaration: null,
            },
            part.old,
            part.new
          );
          break;
        case "renamed":
          at(
            {
              kind: "renamed",
              from: part.from,
              to: part.to,
              sites: part.sites.length,
              declaration: null,
            },
            part.old,
            part.new,
            part.sites
          );
          break;
      }
    }
    return out;
  });
}

const squash = (rows: readonly HunkRow[], kind: HunkRow["kind"]) =>
  rows
    .filter((row) => row.kind === kind)
    .map((row) => row.text)
    .join("")
    .replace(/\s+/g, "");

function blocks(patch: FilePatch): Block[] {
  const out: Block[] = [];
  patch.hunks.forEach((hunk, index) => {
    let current: Block | null = null;
    for (const row of hunk.rows) {
      if (row.kind === "context") {
        current = null;
        continue;
      }
      if (!current) {
        current = {
          hunk: index,
          rows: [],
          oldLines: [],
          newLines: [],
          located: [],
        };
        out.push(current);
      }
      current.rows.push(row);
      if (row.kind === "del" && row.oldLine !== null) current.oldLines.push(row.oldLine);
      if (row.kind === "add" && row.newLine !== null) current.newLines.push(row.newLine);
    }
  });
  return out;
}

const within = (span: LineSpan | null, line: number) =>
  span !== null && span.start <= line && line <= span.end;

const touches = (block: Block, entry: Located) =>
  block.oldLines.some((line) => within(entry.old, line)) ||
  block.newLines.some((line) => within(entry.new, line)) ||
  entry.sites.some(
    (site) =>
      block.oldLines.includes(site.old_line) || block.newLines.includes(site.new_line)
  );

/** Lines before a hunk on one side (`@@ -5,0` sits after line 5). */
const linesBefore = (start: number, count: number) =>
  count === 0 ? start : start - 1;

/** Adds chips not already shown (compared by their text). */
function addChips(target: SemanticChip[], chips: readonly SemanticChip[]) {
  for (const chip of chips)
    if (!target.some((existing) => chipText(existing) === chipText(chip)))
      target.push(chip);
}

function chipsFor(block: Block): SemanticChip[] {
  const chips: SemanticChip[] = [];
  for (const { chip } of block.located) {
    if (chip && chip.kind !== "moved") addChips(chips, [chip]);
  }
  // Something removed and something added in one place is a change there.
  if (chips.some((chip) => chip.kind === "added") && chips.some((chip) => chip.kind === "removed")) {
    const merged = chips.filter((chip) => chip.kind !== "added" && chip.kind !== "removed");
    if (!merged.some((chip) => chip.kind === "changed")) merged.unshift({ kind: "changed" });
    chips.splice(0, chips.length, ...merged);
  }
  // A precise label makes the generic ones redundant.
  if (chips.some((chip) => chip.kind === "renamed" || chip.kind === "signature"))
    return chips.filter(
      (chip) =>
        chip.kind !== "changed" &&
        !((chip.kind === "added" || chip.kind === "removed") && chip.declaration === null)
    );
  return chips;
}

/** Ordinary edit labels sit on the first changed line on the preferred side. */
function labelPlace(block: Block): { side: DiffSide; lineNumber: number } {
  return block.newLines.length > 0
    ? { side: "additions", lineNumber: block.newLines[0] }
    : { side: "deletions", lineNumber: block.oldLines[0] };
}

/**
 * Reveals per gap, and the hunks shown flush against the one before (no gap
 * left between them).
 */
function gapReveals(
  patch: FilePatch,
  headersByHunk: ReadonlyMap<number, ReadonlySet<number>>
): { reveals: Map<number, GapReveal>; joined: Set<number> } {
  const reveals = new Map<number, GapReveal>();
  const joined = new Set<number>();
  let previousEnd = 0;
  patch.hunks.forEach((hunk, index) => {
    const first = linesBefore(hunk.newStart, hunk.newCount) + 1;
    const gapSize = first - 1 - previousEnd;
    if (index > 0 && gapSize <= 0) joined.add(index);
    if (gapSize > 0) {
      for (const line of headersByHunk.get(index) ?? []) {
        if (line >= first) continue;
        if (line <= previousEnd && gapSize <= MAX_REVEAL) {
          reveals.set(index, { top: gapSize, bottom: 0 });
          joined.add(index);
          break;
        }
        const bottom = first - line;
        if (line > previousEnd && bottom <= MAX_REVEAL) {
          reveals.set(index, { top: 0, bottom: Math.max(bottom, reveals.get(index)?.bottom ?? 0) });
        }
      }
    }
    previousEnd = linesBefore(hunk.newStart, hunk.newCount) + hunk.newCount;
  });
  return { reveals, joined };
}

export function semanticHunks(
  patch: FilePatch,
  declarations: readonly DeclarationDiff[],
  revealContext = true
): SemanticHunks {
  const all = locate(declarations);
  const changed = blocks(patch);
  for (const block of changed)
    block.located = all.filter((entry) => touches(block, entry));

  const headersByHunk = new Map<number, Set<number>>();
  if (revealContext) {
    for (const block of changed) {
      const headers = headersByHunk.get(block.hunk) ?? new Set<number>();
      for (const { header, chip, home } of block.located) {
        const owner = !chip && isMember(header) ? home.at(-1) : header;
        const line = owner?.new_line;
        if (chip?.kind !== "moved" && line != null) headers.add(line);
      }
      headersByHunk.set(block.hunk, headers);
    }
  }
  const { reveals, joined } = gapReveals(patch, headersByHunk);

  // Annotations use source line numbers. Only anchor to rows the diff
  // renders, including the unchanged lines we will reveal above a hunk.
  const visible = { additions: new Set<number>(), deletions: new Set<number>() };
  for (const [index, hunk] of patch.hunks.entries()) {
    for (const row of hunk.rows) {
      if (row.oldLine !== null) visible.deletions.add(row.oldLine);
      if (row.newLine !== null) visible.additions.add(row.newLine);
    }
    const bottom = reveals.get(index)?.bottom ?? 0;
    for (let offset = 1; offset <= bottom; offset++) {
      visible.deletions.add(linesBefore(hunk.oldStart, hunk.oldCount) + 1 - offset);
      visible.additions.add(linesBefore(hunk.newStart, hunk.newCount) + 1 - offset);
    }
  }

  const headerAt = (header: ScopeSegment | null) => {
    if (header?.new_line != null && visible.additions.has(header.new_line))
      return { side: "additions" as const, lineNumber: header.new_line };
    if (header?.old_line != null && visible.deletions.has(header.old_line))
      return { side: "deletions" as const, lineNumber: header.old_line };
    return null;
  };

  type Placed = SemanticLabel & { chips: SemanticChip[]; facts: FactGroup[]; declarationIndices: number[] };
  const labels: Placed[] = [];
  const place = (
    { side, lineNumber }: { side: DiffSide; lineNumber: number },
    scope: readonly ScopeSegment[],
    chips: readonly SemanticChip[],
    groups: readonly FactGroup[],
    indices: readonly number[] = [],
    singleLine = false,
    inScope = false
  ) => {
    const existing = labels.find(
      (l) => l.side === side && l.lineNumber === lineNumber
    );
    const label: Placed =
      existing ?? { side, lineNumber, scope, chips: [], facts: [], test: false, declarationIndices: [] };
    if (!existing) labels.push(label);
    if (inScope && scope.length > 0) label.inScope = true;
    if (singleLine && !existing) label.singleLine = true;
    else delete label.singleLine;
    addChips(label.chips, chips);
    addGroups(label.facts, groups);
    for (const index of indices) {
      if (!label.declarationIndices.includes(index)) label.declarationIndices.push(index);
    }
    return label;
  };
  const factsFor = (entry: Located): FactGroup => ({
    owner: entry.owner,
    whole: false,
    facts: entry.facts.items,
    omitted: entry.facts.omitted,
  });

  // Put each move at its own line on both sides. A line-diff block may
  // include unrelated edits, or several moves, on either side.
  const oldLines = changed.flatMap((block) => block.oldLines);
  const newLines = changed.flatMap((block) => block.newLines);
  for (const entry of all) {
    const { chip, old, new: next } = entry;
    if (chip?.kind !== "moved" || !old || !next) continue;
    const from = oldLines.find((line) => within(old, line));
    const to = newLines.find((line) => within(next, line));
    if (from !== undefined) {
      place(
        { side: "deletions", lineNumber: from },
        entry.home,
        [{ ...chip, direction: "to", line: to ?? next.start, side: "additions" }],
        [factsFor(entry)],
        [entry.declarationIndex],
        false,
        chip.declaration === null
      );
    }
    if (to !== undefined) {
      place(
        { side: "additions", lineNumber: to },
        entry.home,
        [{ ...chip, direction: "from", line: from ?? old.start, side: "deletions" }],
        [factsFor(entry)],
        [entry.declarationIndex],
        false,
        chip.declaration === null
      );
    }
  }

  // A line diff can put edits to several declarations in one block.
  // Keep their facts and links with their own declaration.
  const recent = new Map<string, { hunk: number; label: Placed }>();
  for (const block of changed) {
    if (!block.located.length && squash(block.rows, "del") === squash(block.rows, "add")) {
      place(labelPlace(block), [], [{ kind: "formatting" }], []);
    }
    const groups = new Map<string, Located[]>();
    for (const entry of block.located) {
      if (!entry.chip || entry.chip.kind === "moved") continue;
      const group = groups.get(entry.key) ?? [];
      group.push(entry);
      groups.set(entry.key, group);
    }
    for (const [key, entries] of groups) {
      const entry = entries[0];
      const header = headerAt(entry.header);
      const previous = recent.get(key);
      const together = previous &&
        (previous.hunk === block.hunk ||
          (previous.hunk === block.hunk - 1 && joined.has(block.hunk)));
      const touched: Block = {
        ...block,
        located: entries,
        oldLines: block.oldLines.filter((line) => entries.some(({ old, sites }) =>
          within(old, line) || sites.some((site) => site.old_line === line))),
        newLines: block.newLines.filter((line) => entries.some(({ new: next, sites }) =>
          within(next, line) || sites.some((site) => site.new_line === line))),
      };
      recent.set(key, {
        hunk: block.hunk,
        label: place(
          header ?? (together ? previous.label : labelPlace(touched)),
          entry.home,
          chipsFor(touched),
          entries.map(factsFor),
          [entry.declarationIndex],
          !together && touched.oldLines.length <= 1 && touched.newLines.length <= 1,
          !header
        ),
      });
    }
  }

  // Each added or removed declaration is labelled at its own first line
  // (past the comments and attributes before it), else where it starts.
  for (const [index, declaration] of declarations.entries()) {
    const { change, subject } = declaration;
    if ((change.kind !== "added" && change.kind !== "removed") || !subject)
      continue;
    const added = change.kind === "added";
    const span = added ? change.new : change.old;
    const lines = added ? newLines : oldLines;
    const side = added ? "additions" : "deletions";
    if (!lines.some((line) => within(span, line))) continue;
    const member = isMember(subject);
    const owner = member ? headerAt(declaration.scope.at(-1) ?? null) : null;
    const lineNumber = visible[side].has(change.head)
      ? change.head
      : lines.find((line) => line >= change.head && within(span, line));
    if (lineNumber === undefined) continue;
    place(
      owner ?? { side, lineNumber },
      declaration.scope,
      owner ? [] : [{ kind: change.kind, declaration: named(subject) }],
      [
        {
          owner: named(subject),
          whole: true,
          facts: declaration.facts.items,
          omitted: declaration.facts.omitted,
        },
      ],
      [index],
      change.head === span.end,
      member && !owner
    );
  }
  labels.sort(
    (a, b) => a.lineNumber - b.lineNumber || b.side.localeCompare(a.side)
  );
  for (const label of labels) {
    label.test = label.facts.some((group) =>
      group.facts.some((fact) => fact.kind.type === "test_code")
    );
    label.facts = label.facts
      .map((group) => ({
        ...group,
        facts: orderFacts(group.facts.filter((fact) => fact.kind.type !== "test_code")),
      }))
      .filter((group) => group.facts.length > 0 || group.omitted > 0);
  }

  return {
    reveals,
    labels,
    // The engine reports every change beyond whitespace (its coverage
    // invariant), so none means formatting only.
    formattingOnly: changed.length > 0 && declarations.length === 0,
    summary: declarationSummary(declarations),
  };
}

/** The declarations a file adds, removes, renames and moves. */
export function declarationSummary(
  declarations: readonly DeclarationDiff[]
): DeclarationSummary {
  const summary = {
    added: [] as Declared[],
    removed: [] as Declared[],
    renamed: [] as { keyword: string; from: string; to: string }[],
    moved: [] as Declared[],
  };
  for (const { change, subject } of declarations) {
    if (!subject || change.kind === "modified") continue;
    if (change.kind === "renamed")
      summary.renamed.push({
        keyword: subject.keyword,
        from: change.from,
        to: change.to,
      });
    else summary[change.kind].push(named(subject));
  }
  return summary;
}

const label = (declaration: Declared) =>
  `${declaration.keyword} ${declaration.name}`;

/** Counts for a file header, e.g. `2 added · 1 renamed`; empty when none. */
export function summaryCounts(summary: DeclarationSummary): string {
  return (
    [
      [summary.added.length, "added"],
      [summary.removed.length, "removed"],
      [summary.renamed.length, "renamed"],
      [summary.moved.length, "moved"],
    ] as const
  )
    .filter(([count]) => count > 0)
    .map(([count, word]) => `${count} ${word}`)
    .join(" · ");
}

/** Every declaration in a summary, one per line, for a tooltip. */
export function summaryDetail(summary: DeclarationSummary): string {
  return [
    ...summary.added.map((d) => `added ${label(d)}`),
    ...summary.removed.map((d) => `removed ${label(d)}`),
    ...summary.renamed.map((r) => `renamed ${r.keyword} ${r.from} → ${r.to}`),
    ...summary.moved.map((d) => `moved ${label(d)}`),
  ].join("\n");
}

export const FALLBACK_TEXT: Record<LineDiffReason, string> = {
  unsupported_language: "Language not supported for semantic diff",
  syntax_error: "A side has a syntax error",
  too_large: "File is over the semantic diff size budget",
  timed_out: "Semantic diff exceeded its time budget",
  not_text: "Binary, unreadable or non-UTF-8 file",
  request_failed: "Semantic diff failed",
  stale: "The file changed since this diff was loaded",
};

/** One chip as words, e.g. `renamed sum → acc`. */
export function chipText(chip: SemanticChip): string {
  switch (chip.kind) {
    case "added":
    case "removed":
      return chip.declaration
        ? `${chip.kind} ${label(chip.declaration)}`
        : chip.kind;
    case "changed":
      return "changed";
    case "signature":
      return "signature changed";
    case "formatting":
      return "formatting only";
    case "renamed":
      return chip.declaration
        ? `renamed ${chip.declaration.keyword} ${chip.from} → ${chip.to}`
        : `renamed ${chip.from} → ${chip.to}`;
    case "moved":
      return chip.declaration
        ? `moved ${label(chip.declaration)} ${chip.direction} L${chip.line}`
        : `moved ${chip.direction} L${chip.line}`;
  }
}

/**
 * Adds fact groups to a label's: one group per declaration (and whether it
 * is labelled whole), so two declarations on one line keep their own
 * facts; facts already in a group are not repeated.
 */
function addGroups(target: FactGroup[], groups: readonly FactGroup[]) {
  const same = (a: FactGroup["owner"], b: FactGroup["owner"]) =>
    a === b || (a !== null && b !== null && a.keyword === b.keyword && a.name === b.name);
  for (const group of groups) {
    const index = target.findIndex(
      (existing) => existing.whole === group.whole && same(existing.owner, group.owner)
    );
    if (index < 0) {
      target.push({ ...group, facts: [...group.facts] });
      continue;
    }
    const existing = target[index];
    const keys = new Set(existing.facts.map(factKey));
    target[index] = {
      ...existing,
      facts: [...existing.facts, ...group.facts.filter((fact) => !keys.has(factKey(fact)))],
      omitted: existing.omitted + group.omitted,
    };
  }
}

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
 * No React or Pierre runtime imports.
 */
import type {
  DeclarationDiff,
  LineSpan,
  Occurrence,
  ScopeSegment,
} from "../../../bindings";
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
  /** Enclosing declarations, outermost first. */
  scope: readonly ScopeSegment[];
  chips: readonly SemanticChip[];
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
interface Fact {
  /** Null for an added or removed declaration, which is labelled alone. */
  chip: SemanticChip | null;
  old: LineSpan | null;
  new: LineSpan | null;
  sites: readonly Occurrence[];
  home: readonly ScopeSegment[];
  /** Blocks sharing a key describe one declaration. */
  key: string;
}

interface Block {
  hunk: number;
  rows: HunkRow[];
  oldLines: number[];
  newLines: number[];
  facts: Fact[];
}

const named = (segment: ScopeSegment): Declared => ({
  keyword: segment.keyword,
  name: segment.name,
});

function facts(declarations: readonly DeclarationDiff[]): Fact[] {
  return declarations.flatMap((declaration, index): Fact[] => {
    const { scope, subject, change } = declaration;
    const inside = subject ? [...scope, subject] : scope;
    const self = subject && named(subject);
    const out: Fact[] = [];
    const whole = (
      chip: SemanticChip | null,
      old: LineSpan | null,
      next: LineSpan | null,
      sites: readonly Occurrence[] = []
    ) =>
      out.push({ chip, old, new: next, sites, home: scope, key: `${index}` });
    switch (change.kind) {
      case "added":
        whole(null, null, change.new);
        break;
      case "removed":
        whole(null, change.old, null);
        break;
      case "moved":
        // The chip's direction is set per copy (see `chipsFor`).
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
          facts: [],
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

const touches = (block: Block, fact: Fact) =>
  block.oldLines.some((line) => within(fact.old, line)) ||
  block.newLines.some((line) => within(fact.new, line)) ||
  fact.sites.some(
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
  for (const { chip, old, new: next } of block.facts) {
    if (!chip) continue;
    if (chip.kind !== "moved") {
      addChips(chips, [chip]);
      continue;
    }
    // Label each copy with where the other one is.
    if (old && next && block.newLines.some((line) => within(next, line)))
      addChips(chips, [
        { ...chip, direction: "from", line: old.start, side: "deletions" },
      ]);
    if (old && next && block.oldLines.some((line) => within(old, line)))
      addChips(chips, [
        { ...chip, direction: "to", line: next.start, side: "additions" },
      ]);
  }
  // Something removed and something added in one place is a change there.
  if (chips.some((chip) => chip.kind === "added") && chips.some((chip) => chip.kind === "removed")) {
    const merged = chips.filter((chip) => chip.kind !== "added" && chip.kind !== "removed");
    if (!merged.some((chip) => chip.kind === "changed")) merged.unshift({ kind: "changed" });
    chips.splice(0, chips.length, ...merged);
  }
  // A precise label makes the generic ones redundant.
  if (chips.some((chip) => chip.kind === "renamed" || chip.kind === "moved" || chip.kind === "signature"))
    return chips.filter(
      (chip) =>
        chip.kind !== "changed" &&
        !((chip.kind === "added" || chip.kind === "removed") && chip.declaration === null)
    );
  return chips;
}

/**
 * A label sits on the block's first added line, except one that only
 * points from a moved declaration's old copy to its new one, which sits on
 * the old copy itself (not on lines the line diff aligned with it).
 */
function labelPlace(
  block: Block,
  chips: readonly SemanticChip[]
): { side: DiffSide; lineNumber: number } {
  const oldCopy =
    chips.length > 0 && chips.every((chip) => chip.kind === "moved" && chip.direction === "to");
  if (oldCopy && block.oldLines.length > 0) {
    const moved = block.facts.filter((fact) => fact.chip?.kind === "moved");
    const line = block.oldLines.find((line) =>
      moved.some((fact) => within(fact.old, line))
    );
    return { side: "deletions", lineNumber: line ?? block.oldLines[0] };
  }
  return block.newLines.length > 0
    ? { side: "additions", lineNumber: block.newLines[0] }
    : { side: "deletions", lineNumber: block.oldLines[0] };
}

/** A declaration's opening line on the new side, when known. */
function openingLine(scope: readonly ScopeSegment[], patch: FilePatch, hunk: number): number | null {
  const segment = scope.at(-1);
  if (!segment) return null;
  if (segment.new_line !== null) return segment.new_line;
  if (segment.old_line === null) return null;
  // Above a hunk, unchanged lines are offset by the hunk's start difference.
  const { oldStart, newStart } = patch.hunks[hunk];
  return segment.old_line + (newStart - oldStart);
}

/**
 * The fact a block's label is about: the innermost of those it describes
 * (added and removed declarations have labels of their own).
 */
function primary(block: Block): Fact | null {
  const described = block.facts.filter((fact) => fact.chip);
  const candidates = described.length > 0 ? described : block.facts;
  return candidates.reduce<Fact | null>(
    (deepest, fact) =>
      !deepest || fact.home.length > deepest.home.length ? fact : deepest,
    null
  );
}

/**
 * Reveals per gap, and the hunks shown flush against the one before (no gap
 * left between them).
 */
function gapReveals(
  patch: FilePatch,
  hunkHome: ReadonlyMap<number, readonly ScopeSegment[]>
): { reveals: Map<number, GapReveal>; joined: Set<number> } {
  const reveals = new Map<number, GapReveal>();
  const joined = new Set<number>();
  let previousEnd = 0;
  patch.hunks.forEach((hunk, index) => {
    const first = linesBefore(hunk.newStart, hunk.newCount) + 1;
    const gapSize = first - 1 - previousEnd;
    if (index > 0 && gapSize <= 0) joined.add(index);
    const home = hunkHome.get(index);
    const opening = home ? openingLine(home, patch, index) : null;
    if (gapSize > 0 && opening !== null && opening < first) {
      if (opening > previousEnd) {
        // The declaration opens inside this gap: show from its first line.
        const bottom = first - opening;
        if (bottom <= MAX_REVEAL) reveals.set(index, { top: 0, bottom });
      } else if (gapSize <= MAX_REVEAL) {
        // It opened at or above the hunk before: join the two.
        reveals.set(index, { top: gapSize, bottom: 0 });
        joined.add(index);
      }
    }
    previousEnd = linesBefore(hunk.newStart, hunk.newCount) + hunk.newCount;
  });
  return { reveals, joined };
}

export function semanticHunks(
  patch: FilePatch,
  declarations: readonly DeclarationDiff[]
): SemanticHunks {
  const all = facts(declarations);
  const changed = blocks(patch);
  for (const block of changed)
    block.facts = all.filter((fact) => touches(block, fact));

  const hunkHome = new Map<number, readonly ScopeSegment[]>();
  for (const block of changed) {
    const fact = primary(block);
    if (fact && !hunkHome.has(block.hunk)) hunkHome.set(block.hunk, fact.home);
  }
  const { reveals, joined } = gapReveals(patch, hunkHome);

  const labels: (SemanticLabel & { chips: SemanticChip[] })[] = [];
  const place = (
    { side, lineNumber }: { side: DiffSide; lineNumber: number },
    scope: readonly ScopeSegment[],
    chips: readonly SemanticChip[]
  ) => {
    const existing = labels.find(
      (l) => l.side === side && l.lineNumber === lineNumber
    );
    const label = existing ?? { side, lineNumber, scope, chips: [] };
    if (!existing) labels.push(label);
    addChips(label.chips, chips);
    return label;
  };

  // Consecutive blocks of one declaration, shown together, share a label.
  // Each copy of a moved declaration keeps its own: it links to the other.
  const moved = (chips: readonly SemanticChip[]) =>
    chips.some((chip) => chip.kind === "moved");
  let open: {
    key: string;
    hunk: number;
    label: (typeof labels)[number];
  } | null = null;
  for (const block of changed) {
    const fact = primary(block);
    if (!fact) {
      if (squash(block.rows, "del") === squash(block.rows, "add"))
        place(labelPlace(block, []), [], [{ kind: "formatting" }]);
      open = null;
      continue;
    }
    const chips = chipsFor(block);
    if (chips.length === 0) {
      open = null;
      continue;
    }
    const together =
      open !== null &&
      open.key === fact.key &&
      !moved(chips) &&
      !moved(open.label.chips) &&
      (open.hunk === block.hunk || joined.has(block.hunk));
    if (open && together) {
      addChips(open.label.chips, chips);
      open.hunk = block.hunk;
      continue;
    }
    open = {
      key: fact.key,
      hunk: block.hunk,
      label: place(labelPlace(block, chips), fact.home, chips),
    };
  }

  // Each added or removed declaration is labelled where it starts.
  for (const declaration of declarations) {
    const { change, subject } = declaration;
    if ((change.kind !== "added" && change.kind !== "removed") || !subject)
      continue;
    const added = change.kind === "added";
    const span = added ? change.new : change.old;
    const lineNumber = changed
      .flatMap((block) => (added ? block.newLines : block.oldLines))
      .find((line) => within(span, line));
    if (lineNumber === undefined) continue;
    place(
      { side: added ? "additions" : "deletions", lineNumber },
      declaration.scope,
      [{ kind: change.kind, declaration: named(subject) }]
    );
  }
  labels.sort(
    (a, b) => a.lineNumber - b.lineNumber || b.side.localeCompare(a.side)
  );

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

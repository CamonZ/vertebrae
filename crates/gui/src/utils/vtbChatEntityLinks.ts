import type { ChatMessage } from "../stores/chatStore";
import type { VtbEntityType } from "../components/shared/vtbEntityLinkTarget";
import {
  getIndexedStepByWorkflowAndTitle,
  getIndexedVtbEntity,
  getIndexedVtbEntityByTitle,
  UUID_PATTERN,
  type IndexedVtbEntity,
  type VtbEntityIndex,
} from "./vtbChatEntityIndex";

export {
  buildVtbEntityIndex,
  getIndexedVtbEntity,
  indexedVtbEntityFromTask,
} from "./vtbChatEntityIndex";
export type { IndexedVtbEntity, VtbEntityIndex } from "./vtbChatEntityIndex";

const ID_TOKEN_RE = new RegExp(`\\b(?:${UUID_PATTERN}|[0-9a-fA-F]{8})\\b`, "g");
const PAIR_SEPARATOR_RE = /^[\s,;:()[\]{}\-–—◇◆◊♦]*$/;

const NARRATIVE_HEADING_RULES: readonly {
  type: VtbEntityType;
  noun: RegExp;
  context: RegExp;
}[] = [
  {
    type: "step",
    noun: /\bsteps?\b/i,
    context: /^(?:here|these|steps?\b)|\beach workflow\b|\bin each workflow\b/i,
  },
  {
    type: "workflow",
    noun: /\bworkflows?\b/i,
    context: /^(?:you have|here|these|workflows?\b)|\bin this project\b/i,
  },
  {
    type: "epic",
    noun: /\bepics?\b/i,
    context: /^(?:you have|here|these|epics?\b)|\bin this project\b/i,
  },
  {
    type: "ticket",
    noun: /\btickets?\b/i,
    context: /^(?:you have|here|these|tickets?\b)|\bin this project\b/i,
  },
  {
    type: "task",
    noun: /\btasks?\b/i,
    context: /^(?:you have|here|these|tasks?\b)|\bin this project\b/i,
  },
];

interface Span {
  start: number;
  end: number;
}

interface LabelSpan extends Span {
  raw: string;
  text: string;
}

interface Replacement extends Span {
  value: string;
}

interface LinkContext {
  inferredType: VtbEntityType | null;
  workflowId: string | null;
}

interface PairCandidate {
  title?: string;
  entity: IndexedVtbEntity;
}

export function linkifyChatMessages(
  messages: readonly ChatMessage[],
  index: VtbEntityIndex
): readonly ChatMessage[] {
  let changed = false;
  const next = messages.map((message) => {
    const linked = linkifyChatMessage(message, index);
    if (linked !== message) changed = true;
    return linked;
  });

  return changed ? next : messages;
}

export function linkifyChatMessage(
  message: ChatMessage,
  index: VtbEntityIndex
): ChatMessage {
  if (message.kind !== "assistant") return message;

  const linked = linkifyKnownVtbEntities(message.text, index);
  if (linked === message.text) return message;

  return { ...message, text: linked };
}

export function linkifyKnownVtbEntities(
  text: string,
  index: VtbEntityIndex
): string {
  const lines = text.split("\n");
  let inFence = false;
  let changed = false;
  let inferredType: VtbEntityType | null = null;
  let currentWorkflowId: string | null = null;
  const linkedLines = lines.map((line) => {
    if (/^\s*(```|~~~)/.test(line)) {
      inFence = !inFence;
      return line;
    }
    if (inFence) {
      return line;
    }

    const nextInferredType = inferEntityTypeFromSectionHeading(line);
    if (nextInferredType !== undefined) {
      inferredType = nextInferredType;
      if (nextInferredType !== "step") {
        currentWorkflowId = null;
      }
    }

    if (inferredType === "step") {
      const workflow =
        findWorkflowHeadingEntity(line, index) ??
        findExistingWorkflowLinkEntity(line, index);
      if (workflow) {
        currentWorkflowId = workflow.id;
      }
    }

    const linked = linkifyLine(line, index, {
      inferredType,
      workflowId: currentWorkflowId,
    });
    if (linked !== line) changed = true;
    return linked;
  });

  return changed ? linkedLines.join("\n") : text;
}

function linkifyLine(
  line: string,
  index: VtbEntityIndex,
  context: LinkContext
): string {
  let linked = repeatUntilStable(line, (current) =>
    linkifyTitleIdPair(current, knownPairCandidate(index))
  );

  linked = linkifyStandaloneIds(linked, index, {
    allowShortIds: context.inferredType != null,
  });

  linked = linkifyKnownTitleOnlyLine(linked, index, context);
  return linked;
}

function linkifyKnownTitleOnlyLine(
  line: string,
  index: VtbEntityIndex,
  context: LinkContext
): string {
  if (!context.inferredType) return line;

  if (context.inferredType !== "step") {
    const type = context.inferredType;
    return (
      linkifyKnownTableTitleCell(line, index, type) ??
      linkifyKnownListLabel(line, (label) =>
        getIndexedVtbEntityByTitle(index, type, label.text)
      ) ??
      line
    );
  }

  const workflowHeading = linkifyWorkflowHeadingTitle(line, index);
  if (workflowHeading) return workflowHeading;

  const workflowId = context.workflowId;
  const stepFromWorkflow = workflowId
    ? linkifyKnownListLabel(line, (label) =>
        getIndexedStepByWorkflowAndTitle(index, workflowId, label.text)
      )
    : null;
  if (stepFromWorkflow) return stepFromWorkflow;

  return (
    linkifyKnownListLabel(line, (label) =>
      getIndexedVtbEntityByTitle(index, "step", label.text)
    ) ?? line
  );
}

function linkifyKnownTableTitleCell(
  line: string,
  index: VtbEntityIndex,
  type: VtbEntityType
): string | null {
  const trimmed = line.trim();
  if (!trimmed.startsWith("|")) return null;
  if (/^\|?\s*:?-{3,}/.test(trimmed)) return null;

  const match = line.match(/^(\s*\|\s*)([^|]*?)(\s*\|.*)$/);
  if (!match) return null;

  const [, prefix, rawCell, suffix] = match;
  const title = plainMarkdownLabel(rawCell);
  if (!title) return null;

  const entity = getIndexedVtbEntityByTitle(index, type, title);
  if (!entity) return null;

  return `${prefix}${markdownLinkForRawLabel(entity, rawCell, title)}${suffix}`;
}

function linkifyKnownListLabel(
  line: string,
  resolveEntity: (label: LabelSpan) => IndexedVtbEntity | null
): string | null {
  const label = findListItemLabel(line);
  if (!label) return null;

  const entity = resolveEntity(label);
  if (!entity) return null;

  return replaceLabel(line, label, entity);
}

function linkifyWorkflowHeadingTitle(
  line: string,
  index: VtbEntityIndex
): string | null {
  const heading = findWorkflowHeadingLabel(line, index);
  if (!heading) return null;

  return replaceLabel(line, heading.label, heading.entity);
}

function findWorkflowHeadingEntity(
  line: string,
  index: VtbEntityIndex
): IndexedVtbEntity | null {
  return findWorkflowHeadingLabel(line, index)?.entity ?? null;
}

function findWorkflowHeadingLabel(
  line: string,
  index: VtbEntityIndex
): { entity: IndexedVtbEntity; label: LabelSpan } | null {
  const title = workflowHeadingTitle(line);
  if (!title) return null;

  const entity = getIndexedVtbEntityByTitle(index, "workflow", title);
  if (!entity) return null;

  const ignoredSpans = findIgnoredMarkdownSpans(line);
  for (const match of findTitleMatches(line, entity.title, 0)) {
    if (isInsideSpans(match.start, ignoredSpans)) continue;
    return {
      entity,
      label: expandLabelFormattingSpan(line, match),
    };
  }

  return null;
}

function workflowHeadingTitle(line: string): string | null {
  if (/^\s*(?:(?:[-*+•]\s+)|(?:\d+\.\s+))/.test(line)) return null;

  const text = plainMarkdownLabel(line.trim().replace(/^#{1,6}\s+/, ""))
    .replace(/\s*\([^)]*\bsteps?\b[^)]*\)\s*$/i, "")
    .trim();
  if (!text || new RegExp(ID_TOKEN_RE.source, "i").test(text)) return null;

  return text;
}

function findExistingWorkflowLinkEntity(
  line: string,
  index: VtbEntityIndex
): IndexedVtbEntity | null {
  for (const match of line.matchAll(
    /\]\(vtb:\/\/workflow\/([^)?#]+)[^)]*\)/gi
  )) {
    const rawId = decodeURIComponentSafe(match[1]);
    if (!rawId) continue;

    const entity = getIndexedVtbEntity(index, rawId);
    if (entity?.type === "workflow") return entity;
  }

  return null;
}

function findListItemLabel(line: string): LabelSpan | null {
  const match = line.match(/^(\s*(?:(?:[-*+•]\s+)|(?:\d+\.\s+)))(.+)$/);
  if (!match) return null;

  const restStart = match[1].length;
  const rest = line.slice(restStart);
  const leading = rest.match(/^\s*/)?.[0] ?? "";
  const labelStart = restStart + leading.length;
  let raw = rest.slice(leading.length).trimEnd();
  raw = raw.replace(/\s*[.,;:]\s*$/, "");

  const separator = raw.match(/^(.*?)(\s+[-–—]\s+.+)$/);
  if (separator) {
    raw = separator[1].trimEnd();
  }

  const text = plainMarkdownLabel(raw);
  if (!text || new RegExp(ID_TOKEN_RE.source, "i").test(text)) return null;

  return {
    start: labelStart,
    end: labelStart + raw.length,
    raw,
    text,
  };
}

function replaceLabel(
  line: string,
  label: LabelSpan,
  entity: IndexedVtbEntity
): string {
  return `${line.slice(0, label.start)}${markdownLinkForRawLabel(
    entity,
    label.raw,
    label.text
  )}${line.slice(label.end)}`;
}

function linkifyStandaloneIds(
  line: string,
  index: VtbEntityIndex,
  options: { allowShortIds: boolean }
): string {
  const ignoredSpans = findIgnoredMarkdownSpans(line);
  const replacements: Replacement[] = [];
  for (const match of line.matchAll(new RegExp(ID_TOKEN_RE.source, "g"))) {
    if (match.index === undefined) continue;
    if (isInsideSpans(match.index, ignoredSpans)) continue;

    const token = match[0];
    if (token.length === 8 && !options.allowShortIds) continue;

    const entity = getIndexedVtbEntity(index, token);
    if (!entity?.title) continue;

    replacements.push({
      start: match.index,
      end: match.index + token.length,
      value: markdownLinkForEntity(entity, entity.title),
    });
  }

  return applyReplacements(line, replacements);
}

function linkifyTitleIdPair(
  line: string,
  resolveCandidate: (token: string) => PairCandidate | null
): string {
  const ignoredSpans = findIgnoredMarkdownSpans(line);
  for (const match of line.matchAll(new RegExp(ID_TOKEN_RE.source, "g"))) {
    if (match.index === undefined) continue;
    if (isInsideSpans(match.index, ignoredSpans)) continue;

    const candidate = resolveCandidate(match[0]);
    if (!candidate) continue;

    const idSpan = expandIdDecorationSpan(
      line,
      match.index,
      match.index + match[0].length
    );
    const left = candidate.title
      ? findKnownTitleLeft(line, idSpan, candidate.title)
      : findVisibleLabelLeft(line, idSpan);
    if (left) {
      return replaceEntityPair(line, left, idSpan.end, candidate.entity, true);
    }

    const right = candidate.title
      ? findKnownTitleRight(line, idSpan, candidate.title)
      : findVisibleLabelRight(line, idSpan);
    if (right) {
      return replaceEntityPair(
        line,
        { ...right, start: idSpan.start },
        right.end,
        candidate.entity,
        true
      );
    }
  }

  return line;
}

function replaceEntityPair(
  line: string,
  label: LabelSpan,
  replaceEnd: number,
  entity: IndexedVtbEntity,
  dedupeSuffix = false
): string {
  return `${line.slice(0, label.start)}${markdownLinkForRawLabel(
    entity,
    label.raw,
    label.text
  )}${
    dedupeSuffix
      ? dedupeDuplicateTitleSuffix(line.slice(replaceEnd), label.text)
      : line.slice(replaceEnd)
  }`;
}

function expandIdDecorationSpan(
  line: string,
  start: number,
  end: number
): Span {
  let spanStart = start;
  let spanEnd = end;
  const before = line.slice(0, start);
  const after = line.slice(end);
  const prefix = before.match(/(?:\(\s*)?(?:[◇◆◊♦]\s*)?$/)?.[0] ?? "";
  const suffix = after.match(/^\s*\)/)?.[0] ?? "";

  if (prefix.includes("(") && suffix.includes(")")) {
    spanStart = start - prefix.length;
    spanEnd = end + suffix.length;
  } else if (!prefix.includes("(") && prefix.trim()) {
    spanStart = start - prefix.length;
  }

  return { start: spanStart, end: spanEnd };
}

function findKnownTitleLeft(
  line: string,
  idSpan: Span,
  title: string
): LabelSpan | null {
  let best: LabelSpan | null = null;
  for (const match of findTitleMatches(line.slice(0, idSpan.start), title, 0)) {
    const label = expandLabelFormattingSpan(line, match);
    if (isPairSeparator(line.slice(label.end, idSpan.start))) {
      best = label;
    }
  }
  return best;
}

function findKnownTitleRight(
  line: string,
  idSpan: Span,
  title: string
): LabelSpan | null {
  for (const match of findTitleMatches(
    line.slice(idSpan.end),
    title,
    idSpan.end
  )) {
    const label = expandLabelFormattingSpan(line, match);
    if (isPairSeparator(line.slice(idSpan.end, label.start))) {
      return label;
    }
  }
  return null;
}

function findTitleMatches(
  region: string,
  title: string,
  offset: number
): Span[] {
  const pattern = title.trim().split(/\s+/).map(escapeRegExp).join("\\s+");
  if (!pattern) return [];

  const matches: Span[] = [];
  const regex = new RegExp(pattern, "gi");
  for (const match of region.matchAll(regex)) {
    if (match.index === undefined) continue;
    matches.push({
      start: offset + match.index,
      end: offset + match.index + match[0].length,
    });
  }
  return matches;
}

function findVisibleLabelLeft(line: string, idSpan: Span): LabelSpan | null {
  const before = line.slice(0, idSpan.start).replace(/\s*[-–—:,;]\s*$/, "");
  const parts = splitPrefixAndLabel(before);
  if (!parts) return null;

  const labelStart = parts.prefix.length;
  const raw = parts.label.replace(/\s+$/, "");
  const text = plainMarkdownLabel(raw);
  if (!text) return null;

  return {
    start: labelStart,
    end: labelStart + raw.length,
    raw,
    text,
  };
}

function findVisibleLabelRight(line: string, idSpan: Span): LabelSpan | null {
  const after = line.slice(idSpan.end);
  const separator = after.match(/^\s*(?:[-–—:,;]\s*)?/)?.[0] ?? "";
  const labelStart = idSpan.end + separator.length;
  const labelEnd = line.length;
  const raw = line.slice(labelStart, labelEnd).replace(/\s*[.,;:]\s*$/, "");
  const text = plainMarkdownLabel(raw);
  if (!text) return null;

  return {
    start: labelStart,
    end: labelStart + raw.length,
    raw,
    text,
  };
}

function expandLabelFormattingSpan(line: string, span: Span): LabelSpan {
  for (const marker of ["**", "__"]) {
    if (
      span.start >= marker.length &&
      line.slice(span.start - marker.length, span.start) === marker &&
      line.slice(span.end, span.end + marker.length) === marker
    ) {
      const start = span.start - marker.length;
      const end = span.end + marker.length;
      const raw = line.slice(start, end);
      return {
        start,
        end,
        raw,
        text: plainMarkdownLabel(raw),
      };
    }
  }

  const raw = line.slice(span.start, span.end);
  return {
    ...span,
    raw,
    text: plainMarkdownLabel(raw),
  };
}

function isPairSeparator(value: string): boolean {
  return PAIR_SEPARATOR_RE.test(value);
}

function inferEntityTypeFromSectionHeading(
  line: string
): VtbEntityType | null | undefined {
  const rawHeading = plainMarkdownLabel(
    line.trim().replace(/^#{1,6}\s+/, "")
  ).trim();
  if (/^summary\b/i.test(rawHeading)) return null;

  const heading = normalizedSectionHeading(line);
  if (!heading) return undefined;

  const narrativeType = entityTypeFromNarrativeHeading(rawHeading);
  if (narrativeType) return narrativeType;

  const type = entityTypeFromHeading(heading);
  if (type) return type;
  return undefined;
}

function normalizedSectionHeading(line: string): string | null {
  const trimmed = line.trim();
  if (!trimmed) return null;

  let text = trimmed
    .replace(/^#{1,6}\s+/, "")
    .replace(/:$/, "")
    .trim();
  text = plainMarkdownLabel(text)
    .replace(/\s*\([^)]*\)\s*$/, "")
    .trim();

  if (!text || new RegExp(ID_TOKEN_RE.source, "i").test(text)) return null;
  return text;
}

function entityTypeFromHeading(heading: string): VtbEntityType | null {
  const match = heading.match(
    /\b(epics?|tickets?|tasks?|workflows?|steps?|projects?)$/i
  );
  if (!match) return null;

  const noun = match[1].toLocaleLowerCase().replace(/s$/, "");
  switch (noun) {
    case "epic":
    case "ticket":
    case "task":
    case "workflow":
    case "step":
    case "project":
      return noun;
    default:
      return null;
  }
}

function entityTypeFromNarrativeHeading(heading: string): VtbEntityType | null {
  const text = heading.replace(/:$/, "").trim();
  let best: { type: VtbEntityType; index: number } | null = null;

  for (const rule of NARRATIVE_HEADING_RULES) {
    const match = text.match(rule.noun);
    if (!match || !rule.context.test(text)) continue;

    const index = match.index ?? Number.MAX_SAFE_INTEGER;
    if (!best || index < best.index) {
      best = { type: rule.type, index };
    }
  }

  return best?.type ?? null;
}

function findMarkdownLinkSpans(line: string): Span[] {
  const spans: Span[] = [];
  let searchStart = 0;
  while (searchStart < line.length) {
    const labelStart = line.indexOf("[", searchStart);
    if (labelStart === -1) break;

    const labelEnd = findUnescaped(line, "]", labelStart + 1);
    if (labelEnd === -1 || line[labelEnd + 1] !== "(") {
      searchStart = labelStart + 1;
      continue;
    }

    const hrefEnd = line.indexOf(")", labelEnd + 2);
    if (hrefEnd === -1) break;

    spans.push({ start: labelStart, end: hrefEnd + 1 });
    searchStart = hrefEnd + 1;
  }
  return spans;
}

function findIgnoredMarkdownSpans(line: string): Span[] {
  return [...findMarkdownLinkSpans(line), ...findInlineCodeSpans(line)];
}

function findInlineCodeSpans(line: string): Span[] {
  const spans: Span[] = [];
  let cursor = 0;

  while (cursor < line.length) {
    const start = findUnescaped(line, "`", cursor);
    if (start === -1) break;

    const markerLength = countRepeated(line, start, "`");
    const marker = "`".repeat(markerLength);
    let searchStart = start + markerLength;
    let end = -1;

    while (searchStart < line.length) {
      const candidate = findUnescaped(line, "`", searchStart);
      if (candidate === -1) break;
      if (line.slice(candidate, candidate + markerLength) === marker) {
        end = candidate + markerLength;
        break;
      }
      searchStart = candidate + 1;
    }

    if (end === -1) break;
    spans.push({ start, end });
    cursor = end;
  }

  return spans;
}

function countRepeated(line: string, start: number, char: string): number {
  let count = 0;
  while (line[start + count] === char) count += 1;
  return count;
}

function findUnescaped(line: string, needle: string, start: number): number {
  for (let i = start; i < line.length; i += 1) {
    if (line[i] !== needle) continue;

    let slashCount = 0;
    for (
      let cursor = i - 1;
      cursor >= 0 && line[cursor] === "\\";
      cursor -= 1
    ) {
      slashCount += 1;
    }
    if (slashCount % 2 === 0) return i;
  }
  return -1;
}

function isInsideSpans(index: number, spans: readonly Span[]): boolean {
  return spans.some((span) => index >= span.start && index < span.end);
}

function applyReplacements(
  line: string,
  replacements: readonly Replacement[]
): string {
  if (replacements.length === 0) return line;

  let next = line;
  for (const replacement of [...replacements].sort(
    (a, b) => b.start - a.start
  )) {
    next = `${next.slice(0, replacement.start)}${replacement.value}${next.slice(
      replacement.end
    )}`;
  }
  return next;
}

function repeatUntilStable(
  line: string,
  rewrite: (line: string) => string
): string {
  let next = line;
  for (let i = 0; i < 20; i += 1) {
    const rewritten = rewrite(next);
    if (rewritten === next) break;
    next = rewritten;
  }
  return next;
}

function markdownLinkForEntity(
  entity: IndexedVtbEntity,
  label: string
): string {
  return `[${escapeMarkdownLabel(label)}](vtb://${entity.type}/${entity.id})`;
}

function dedupeDuplicateTitleSuffix(suffix: string, title: string): string {
  const pattern = title.trim().split(/\s+/).map(escapeRegExp).join("\\s+");
  if (!pattern) return suffix;

  const match = suffix.match(
    new RegExp(`^\\s*(?:[-–—:]\\s*)?${pattern}(?=$|\\s|[.,;:)\\]])`, "i")
  );
  return match ? suffix.slice(match[0].length) : suffix;
}

function splitPrefixAndLabel(
  beforeParenthetical: string
): { prefix: string; label: string } | null {
  const listMatch = beforeParenthetical.match(
    /^(\s*(?:(?:[-*+•]\s+)|(?:\d+\.\s+))?)(.*)$/
  );
  if (!listMatch) return null;

  let prefix = listMatch[1];
  let label = listMatch[2];
  const colonMatch = label.match(/^(.*:\s+)(.+)$/);
  if (colonMatch) {
    prefix += colonMatch[1];
    label = colonMatch[2];
  }

  return label.trim() ? { prefix, label } : null;
}

function markdownLinkForRawLabel(
  entity: IndexedVtbEntity,
  rawLabel: string,
  labelText: string
): string {
  const emphasized = rawLabel.match(/^(\s*)(\*\*|__)(.+)\2(\s*)$/);
  if (emphasized) {
    const [, leading, marker, inner, trailing] = emphasized;
    return `${leading}${marker}${markdownLinkForEntity(
      entity,
      plainMarkdownLabel(inner) || labelText
    )}${marker}${trailing}`;
  }

  const leading = rawLabel.match(/^\s*/)?.[0] ?? "";
  const trailing = rawLabel.match(/\s*$/)?.[0] ?? "";
  return `${leading}${markdownLinkForEntity(entity, labelText)}${trailing}`;
}

function plainMarkdownLabel(value: string): string {
  return value
    .trim()
    .replace(/^(\*\*|__)(.*)\1$/, "$2")
    .replace(/\\([\\[\]])/g, "$1")
    .trim();
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function escapeMarkdownLabel(value: string): string {
  return value
    .replace(/\\/g, "\\\\")
    .replace(/\[/g, "\\[")
    .replace(/\]/g, "\\]");
}

function decodeURIComponentSafe(value: string): string | null {
  try {
    return decodeURIComponent(value);
  } catch {
    return null;
  }
}

function knownPairCandidate(
  index: VtbEntityIndex
): (token: string) => PairCandidate | null {
  return (token) => {
    const entity = getIndexedVtbEntity(index, token);
    if (!entity) return null;

    return {
      title: entity.title || undefined,
      entity,
    };
  };
}

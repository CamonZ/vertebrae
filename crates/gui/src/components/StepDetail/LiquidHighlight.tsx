import { Fragment, type ReactNode } from "react";

export type LiquidTokenKind =
  | "text"
  | "delimiter"
  | "filter"
  | "string"
  | "number"
  | "keyword"
  | "identifier"
  | "operator";

export interface LiquidToken {
  kind: LiquidTokenKind;
  value: string;
}

const LIQUID_KEYWORDS = new Set([
  "if",
  "elsif",
  "else",
  "endif",
  "unless",
  "endunless",
  "for",
  "endfor",
  "in",
  "case",
  "when",
  "endcase",
  "assign",
  "capture",
  "endcapture",
  "include",
  "render",
  "with",
  "as",
  "break",
  "continue",
  "and",
  "or",
  "not",
  "true",
  "false",
  "nil",
  "empty",
  "blank",
]);

// Capture an output {{ ... }} or tag {% ... %} block with its open/inner/close parts.
const BLOCK_RE =
  /(\{\{-?)([\s\S]*?)(-?\}\})|(\{%-?)([\s\S]*?)(-?%\})/g;

// Inner-block lexemes: string | number | filter pipe | operator | identifier.
const INNER_RE =
  /("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*')|(-?\d+(?:\.\d+)?)|(\|)|(==|!=|<=|>=|[<>=:,.])|([A-Za-z_][A-Za-z0-9_-]*)/g;

export function tokenizeLiquid(source: string): LiquidToken[] {
  const tokens: LiquidToken[] = [];
  if (!source) return tokens;

  let lastIndex = 0;
  for (const match of source.matchAll(BLOCK_RE)) {
    const start = match.index ?? 0;
    const block = match[0];
    const isOutput = match[1] !== undefined;
    const open = isOutput ? match[1] : match[4];
    const inner = isOutput ? match[2] : match[5];
    const close = isOutput ? match[3] : match[6];
    if (start > lastIndex) {
      tokens.push({ kind: "text", value: source.slice(lastIndex, start) });
    }

    tokens.push({ kind: "delimiter", value: open });
    tokens.push(...tokenizeInner(inner, isOutput));
    tokens.push({ kind: "delimiter", value: close });

    lastIndex = start + block.length;
  }

  if (lastIndex < source.length) {
    tokens.push({ kind: "text", value: source.slice(lastIndex) });
  }

  return tokens;
}

function tokenizeInner(inner: string, isOutput: boolean): LiquidToken[] {
  const tokens: LiquidToken[] = [];
  let last = 0;
  let firstIdentSeen = false;

  for (const match of inner.matchAll(INNER_RE)) {
    const start = match.index ?? 0;
    const [value, str, num, pipe, op, ident] = match;
    if (start > last) {
      tokens.push({ kind: "text", value: inner.slice(last, start) });
    }

    if (str !== undefined) {
      tokens.push({ kind: "string", value });
    } else if (num !== undefined) {
      tokens.push({ kind: "number", value });
    } else if (pipe !== undefined) {
      tokens.push({ kind: "filter", value });
    } else if (op !== undefined) {
      tokens.push({ kind: "operator", value });
    } else if (ident !== undefined) {
      // In tag blocks the leading identifier is the tag name (treat as keyword).
      const isTagName = !isOutput && !firstIdentSeen;
      const kind: LiquidTokenKind =
        LIQUID_KEYWORDS.has(ident) || isTagName ? "keyword" : "identifier";
      tokens.push({ kind, value });
      firstIdentSeen = true;
    }

    last = start + value.length;
  }

  if (last < inner.length) {
    tokens.push({ kind: "text", value: inner.slice(last) });
  }

  return tokens;
}

const TOKEN_CLASSES: Record<LiquidTokenKind, string> = {
  text: "",
  delimiter: "text-accent font-semibold",
  filter: "text-accent",
  string: "text-success",
  number: "text-info",
  keyword: "text-warning",
  identifier: "text-text-primary",
  operator: "text-text-muted",
};

interface LiquidHighlightProps {
  source: string;
  className?: string;
  "data-testid"?: string;
}

export function LiquidHighlight({
  source,
  className = "",
  "data-testid": testId = "liquid-highlight",
}: LiquidHighlightProps) {
  const tokens = tokenizeLiquid(source);
  return (
    <code
      data-testid={testId}
      className={`block whitespace-pre-wrap break-words font-mono text-sm leading-relaxed ${className}`}
    >
      {tokens.map((tok, idx) => renderToken(tok, idx))}
    </code>
  );
}

function renderToken(tok: LiquidToken, key: number): ReactNode {
  if (tok.kind === "text") {
    return <Fragment key={key}>{tok.value}</Fragment>;
  }
  return (
    <span key={key} data-token={tok.kind} className={TOKEN_CLASSES[tok.kind]}>
      {tok.value}
    </span>
  );
}

import type { ReactNode } from "react";
import type { ConversationEvent } from "../../types/conversation";
import type { TimelineMarker, DelegationEdge } from "./timeline";

export type GlyphName =
  | "play"
  | "stop"
  | "brain"
  | "terminal"
  | "file-text"
  | "search"
  | "folder-search"
  | "edit"
  | "file-plus"
  | "globe"
  | "git-branch"
  | "file-output"
  | "wrench"
  | "arrow-right"
  | "rotate-cw"
  | "x-circle"
  | "check-circle"
  | "shuffle"
  | "play-circle"
  | "flag";

const TOOL_GLYPHS: Record<string, GlyphName> = {
  Bash: "terminal",
  Read: "file-text",
  Grep: "search",
  Glob: "folder-search",
  Edit: "edit",
  Write: "file-plus",
  WebFetch: "globe",
  WebSearch: "search",
  Task: "git-branch",
  TaskOutput: "file-output",
  mcp__morph_mcp__edit_file: "edit",
  mcp__morph_mcp__warpgrep_codebase_search: "search",
};

function toolNameToGlyph(toolName: string): GlyphName {
  if (toolName in TOOL_GLYPHS) return TOOL_GLYPHS[toolName];
  if (toolName.includes("warpgrep") || toolName.includes("search"))
    return "search";
  if (toolName.includes("edit")) return "edit";
  return "wrench";
}

export type GlyphInput = ConversationEvent | TimelineMarker | DelegationEdge;

export interface ResolvedGlyph {
  glyph: GlyphName;
  variant: "default" | "filled" | "error";
  label: string;
}

export function resolveGlyph(input: GlyphInput): ResolvedGlyph {
  if ("kind" in input && "lane" in input) {
    if (input.lane === "threshold") {
      switch (input.kind) {
        case "transition":
          return { glyph: "arrow-right", variant: "default", label: "transition" };
        case "retry":
          return { glyph: "rotate-cw", variant: "default", label: "retry" };
        case "rejection":
          return { glyph: "x-circle", variant: "error", label: "rejection" };
        case "approval":
          return { glyph: "check-circle", variant: "default", label: "approval" };
        case "model_fallback":
          return { glyph: "shuffle", variant: "default", label: "model fallback" };
        case "execution_start":
          return { glyph: "play-circle", variant: "default", label: "execution start" };
        case "execution_end":
          return { glyph: "flag", variant: "default", label: "execution end" };
      }
    }
    if (input.lane === "tool") {
      const glyph = toolNameToGlyph(input.toolName);
      if (input.kind === "tool_result") {
        return {
          glyph,
          variant: input.isError ? "error" : "filled",
          label: input.isError ? "tool error" : "tool result",
        };
      }
      return { glyph, variant: "default", label: "tool call" };
    }
    if (input.lane === "main") {
      return { glyph: "brain", variant: "default", label: "thinking" };
    }
  }

  if ("lane" in input && input.lane === "delegation") {
    return { glyph: "git-branch", variant: "default", label: "delegation" };
  }

  const ev = input as ConversationEvent;
  switch (ev.kind) {
    case "session_start":
      return { glyph: "play", variant: "default", label: "session start" };
    case "session_end":
      return { glyph: "stop", variant: "default", label: "session end" };
    case "thinking":
      return { glyph: "brain", variant: "default", label: "thinking" };
    case "tool_call":
      return {
        glyph: toolNameToGlyph(ev.toolName),
        variant: "default",
        label: "tool call",
      };
    case "tool_result":
      return {
        glyph: "wrench",
        variant: ev.isError ? "error" : "filled",
        label: ev.isError ? "tool error" : "tool result",
      };
  }
}

const VARIANT_CLASS: Record<ResolvedGlyph["variant"], string> = {
  default: "text-text-secondary",
  filled: "text-text-primary",
  error: "text-status-error",
};

interface GlyphDef {
  stroke: number;
  body: ReactNode;
}

const GLYPHS: Record<GlyphName, GlyphDef> = {
  play: { stroke: 1.75, body: <polygon points="6 4 20 12 6 20 6 4" /> },
  stop: { stroke: 1.75, body: <rect x="5" y="5" width="14" height="14" rx="1" /> },
  brain: {
    stroke: 1.5,
    body: (
      <>
        <path d="M12 5a3 3 0 0 0-5.997.125 4 4 0 0 0-2.526 5.77 4 4 0 0 0 .556 6.588A4 4 0 0 0 12 21Z" />
        <path d="M12 5a3 3 0 1 1 5.997.125 4 4 0 0 1 2.526 5.77 4 4 0 0 1-.556 6.588A4 4 0 0 1 12 21Z" />
      </>
    ),
  },
  terminal: {
    stroke: 1.5,
    body: (
      <>
        <polyline points="4 17 10 11 4 5" />
        <line x1="12" y1="19" x2="20" y2="19" />
      </>
    ),
  },
  "file-text": {
    stroke: 1.5,
    body: (
      <>
        <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
        <polyline points="14 2 14 8 20 8" />
        <line x1="8" y1="13" x2="16" y2="13" />
        <line x1="8" y1="17" x2="16" y2="17" />
      </>
    ),
  },
  search: {
    stroke: 1.5,
    body: (
      <>
        <circle cx="11" cy="11" r="7" />
        <line x1="21" y1="21" x2="16.65" y2="16.65" />
      </>
    ),
  },
  "folder-search": {
    stroke: 1.5,
    body: (
      <>
        <path d="M22 11V8a2 2 0 0 0-2-2h-7l-2-2H4a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h6" />
        <circle cx="17" cy="17" r="3" />
        <line x1="21" y1="21" x2="19.1" y2="19.1" />
      </>
    ),
  },
  edit: {
    stroke: 1.5,
    body: (
      <>
        <path d="M12 20h9" />
        <path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4 12.5-12.5z" />
      </>
    ),
  },
  "file-plus": {
    stroke: 1.5,
    body: (
      <>
        <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
        <polyline points="14 2 14 8 20 8" />
        <line x1="12" y1="12" x2="12" y2="18" />
        <line x1="9" y1="15" x2="15" y2="15" />
      </>
    ),
  },
  globe: {
    stroke: 1.5,
    body: (
      <>
        <circle cx="12" cy="12" r="10" />
        <line x1="2" y1="12" x2="22" y2="12" />
        <path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z" />
      </>
    ),
  },
  "git-branch": {
    stroke: 1.5,
    body: (
      <>
        <line x1="6" y1="3" x2="6" y2="15" />
        <circle cx="18" cy="6" r="3" />
        <circle cx="6" cy="18" r="3" />
        <path d="M18 9a9 9 0 0 1-9 9" />
      </>
    ),
  },
  "file-output": {
    stroke: 1.5,
    body: (
      <>
        <path d="M4 7V4a2 2 0 0 1 2-2h9l5 5v13a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2v-3" />
        <polyline points="14 2 14 8 20 8" />
        <line x1="2" y1="15" x2="11" y2="15" />
        <polyline points="8 12 11 15 8 18" />
      </>
    ),
  },
  wrench: {
    stroke: 1.5,
    body: (
      <path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z" />
    ),
  },
  "arrow-right": {
    stroke: 1.75,
    body: (
      <>
        <line x1="5" y1="12" x2="19" y2="12" />
        <polyline points="12 5 19 12 12 19" />
      </>
    ),
  },
  "rotate-cw": {
    stroke: 1.75,
    body: (
      <>
        <polyline points="21 2 21 8 15 8" />
        <path d="M3 12a9 9 0 0 1 15-6.7L21 8" />
        <path d="M21 12a9 9 0 0 1-15 6.7L3 16" />
      </>
    ),
  },
  "x-circle": {
    stroke: 1.75,
    body: (
      <>
        <circle cx="12" cy="12" r="10" />
        <line x1="15" y1="9" x2="9" y2="15" />
        <line x1="9" y1="9" x2="15" y2="15" />
      </>
    ),
  },
  "check-circle": {
    stroke: 1.75,
    body: (
      <>
        <path d="M22 11.08V12a10 10 0 1 1-5.93-9.14" />
        <polyline points="22 4 12 14.01 9 11.01" />
      </>
    ),
  },
  shuffle: {
    stroke: 1.75,
    body: (
      <>
        <polyline points="16 3 21 3 21 8" />
        <line x1="4" y1="20" x2="21" y2="3" />
        <polyline points="21 16 21 21 16 21" />
        <line x1="15" y1="15" x2="21" y2="21" />
        <line x1="4" y1="4" x2="9" y2="9" />
      </>
    ),
  },
  "play-circle": {
    stroke: 1.75,
    body: (
      <>
        <circle cx="12" cy="12" r="10" />
        <polygon points="10 8 16 12 10 16 10 8" />
      </>
    ),
  },
  flag: {
    stroke: 1.75,
    body: (
      <>
        <path d="M4 15s1-1 4-1 5 2 8 2 4-1 4-1V3s-1 1-4 1-5-2-8-2-4 1-4 1z" />
        <line x1="4" y1="22" x2="4" y2="15" />
      </>
    ),
  },
};

export interface EventGlyphProps {
  event: GlyphInput;
  size?: number;
  className?: string;
  title?: string;
}

export function EventGlyph({
  event,
  size = 16,
  className,
  title,
}: EventGlyphProps): ReactNode {
  const resolved = resolveGlyph(event);
  const def = GLYPHS[resolved.glyph];
  const label = title ?? resolved.label;
  const cls = [VARIANT_CLASS[resolved.variant], "inline-block flex-shrink-0", className]
    .filter(Boolean)
    .join(" ");
  return (
    <span
      data-testid="event-glyph"
      data-glyph={resolved.glyph}
      data-variant={resolved.variant}
      data-label={resolved.label}
      aria-label={label}
      title={label}
      className={cls}
    >
      <svg
        viewBox="0 0 24 24"
        fill={resolved.variant === "filled" ? "currentColor" : "none"}
        stroke="currentColor"
        strokeWidth={def.stroke}
        strokeLinecap="round"
        strokeLinejoin="round"
        width={size}
        height={size}
        aria-hidden="true"
      >
        {def.body}
      </svg>
    </span>
  );
}

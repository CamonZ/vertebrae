import { memo, type ComponentPropsWithoutRef } from "react";
import Markdown from "react-markdown";
import remarkBreaks from "remark-breaks";
import remarkGfm from "remark-gfm";
import { Prism as SyntaxHighlighter } from "react-syntax-highlighter";
import { vscDarkPlus } from "react-syntax-highlighter/dist/esm/styles/prism";

interface MarkdownContentProps {
  text: string;
}

const remarkPlugins = [remarkGfm, remarkBreaks];

const syntaxTheme = {
  ...vscDarkPlus,
  'pre[class*="language-"]': {
    ...(vscDarkPlus['pre[class*="language-"]'] as React.CSSProperties),
    background: "var(--color-bg)",
    margin: 0,
    borderRadius: "var(--radius-md)",
  },
  'code[class*="language-"]': {
    ...(vscDarkPlus['code[class*="language-"]'] as React.CSSProperties),
    background: "none",
  },
};

type CodeProps = ComponentPropsWithoutRef<"code"> & {
  inline?: boolean;
  node?: unknown;
};

const codeBlockStyle: React.CSSProperties = {
  margin: 0,
  padding: "0.75rem",
  background: "var(--color-bg)",
  fontSize: "var(--text-13)",
  lineHeight: "1.6",
  overflow: "auto",
  maxHeight: "24rem",
  maxWidth: "100%",
};

const codeTagStyle = {
  className: "font-mono",
};

const components = {
  p: ({ children, ...props }: ComponentPropsWithoutRef<"p">) => (
    <p
      className="mb-2 text-base leading-relaxed text-fg antialiased last:mb-0"
      {...props}
    >
      {children}
    </p>
  ),
  h1: ({ children, ...props }: ComponentPropsWithoutRef<"h1">) => (
    <h1
      className="mb-3 mt-4 text-xl font-bold text-fg first:mt-0"
      {...props}
    >
      {children}
    </h1>
  ),
  h2: ({ children, ...props }: ComponentPropsWithoutRef<"h2">) => (
    <h2
      className="mb-2 mt-3 text-lg font-semibold text-fg first:mt-0"
      {...props}
    >
      {children}
    </h2>
  ),
  h3: ({ children, ...props }: ComponentPropsWithoutRef<"h3">) => (
    <h3
      className="mb-2 mt-3 text-base font-semibold text-fg first:mt-0"
      {...props}
    >
      {children}
    </h3>
  ),
  h4: ({ children, ...props }: ComponentPropsWithoutRef<"h4">) => (
    <h4
      className="mb-1 mt-2 text-sm font-semibold text-fg first:mt-0"
      {...props}
    >
      {children}
    </h4>
  ),
  ul: ({ children, ...props }: ComponentPropsWithoutRef<"ul">) => (
    <ul
      className="mb-2 ml-4 list-disc space-y-1 text-base text-fg"
      {...props}
    >
      {children}
    </ul>
  ),
  ol: ({ children, ...props }: ComponentPropsWithoutRef<"ol">) => (
    <ol
      className="mb-2 ml-4 list-decimal space-y-1 text-base text-fg"
      {...props}
    >
      {children}
    </ol>
  ),
  li: ({ children, ...props }: ComponentPropsWithoutRef<"li">) => (
    <li className="leading-relaxed" {...props}>
      {children}
    </li>
  ),
  blockquote: ({
    children,
    ...props
  }: ComponentPropsWithoutRef<"blockquote">) => (
    <blockquote
      className="mb-2 border-l-2 border-accent/50 pl-3 text-fg-soft italic"
      {...props}
    >
      {children}
    </blockquote>
  ),
  a: ({ children, ...props }: ComponentPropsWithoutRef<"a">) => (
    <a
      className="text-accent underline decoration-accent/30 hover:decoration-accent"
      target="_blank"
      rel="noopener noreferrer"
      {...props}
    >
      {children}
    </a>
  ),
  table: ({ children, ...props }: ComponentPropsWithoutRef<"table">) => (
    <div className="mb-2 overflow-x-auto">
      <table className="w-full border-collapse text-sm" {...props}>
        {children}
      </table>
    </div>
  ),
  thead: ({ children, ...props }: ComponentPropsWithoutRef<"thead">) => (
    <thead className="border-b border-border" {...props}>
      {children}
    </thead>
  ),
  th: ({ children, ...props }: ComponentPropsWithoutRef<"th">) => (
    <th
      className="px-3 py-1.5 text-left text-xs font-medium text-fg-soft"
      {...props}
    >
      {children}
    </th>
  ),
  td: ({ children, ...props }: ComponentPropsWithoutRef<"td">) => (
    <td
      className="border-t border-border/50 px-3 py-1.5 text-fg"
      {...props}
    >
      {children}
    </td>
  ),
  hr: (props: ComponentPropsWithoutRef<"hr">) => (
    <hr className="my-3 border-border" {...props} />
  ),
  strong: ({ children, ...props }: ComponentPropsWithoutRef<"strong">) => (
    <strong className="font-semibold text-fg" {...props}>
      {children}
    </strong>
  ),
  em: ({ children, ...props }: ComponentPropsWithoutRef<"em">) => (
    // Inline prose emphasis (cursive role b): Newsreader serif italic at full
    // --fg — NOT copper. Distinct from a heading's copper accent word.
    <em className="font-serif italic text-[var(--color-fg)]" {...props}>
      {children}
    </em>
  ),
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  code: ({ inline, className, children, node, ...props }: CodeProps) => {
    const match = /language-(\w+)/.exec(className || "");
    const language = match?.[1] ?? "text";
    let codeString = String(children).replace(/\n$/, "");

    if (language === "json") {
      codeString = prettyPrintJsonIfPossible(codeString);
    }

    if (!inline && (match || codeString.includes("\n"))) {
      return (
        <div className="group relative mb-2 max-w-full min-w-0 overflow-hidden rounded-md border border-border/50 bg-bg">
          {match && (
            <div className="flex items-center border-b border-border/50 px-3 py-1">
              <span className="font-mono text-eyebrow text-fg-mute">
                {match[1]}
              </span>
            </div>
          )}
          <SyntaxHighlighter
            style={syntaxTheme as { [key: string]: React.CSSProperties }}
            language={language}
            PreTag="div"
            customStyle={codeBlockStyle}
            codeTagProps={codeTagStyle}
          >
            {codeString}
          </SyntaxHighlighter>
        </div>
      );
    }

    return (
      <code
        className="rounded bg-bg/80 px-1.5 py-0.5 font-mono text-13 text-accent"
        {...props}
      >
        {children}
      </code>
    );
  },
};

/**
 * Normalize Elixir map syntax (`%{}` with `=>` or unicode `⇒` separators)
 * to JSON syntax so the standard parser can read it. The walker tracks
 * string and escape state, so `=>` or `⇒` inside a JSON string value is
 * preserved verbatim and never substituted. A pure-JSON input passes
 * through unchanged because there is nothing to replace.
 *
 * Elixir-specific constructs we do NOT handle (atoms, charlists, tuples,
 * ranges) will simply fail the downstream `JSON.parse`, leaving the
 * original source intact.
 */
function convertElixirMapToJson(source: string): string {
  let result = "";
  let i = 0;
  let inString = false;
  let escape = false;
  while (i < source.length) {
    const c = source[i];
    if (escape) {
      result += c;
      escape = false;
      i++;
      continue;
    }
    if (inString) {
      result += c;
      if (c === "\\") escape = true;
      else if (c === '"') inString = false;
      i++;
      continue;
    }
    if (c === '"') {
      result += c;
      inString = true;
      i++;
      continue;
    }
    if (c === "%" && source[i + 1] === "{") {
      result += "{";
      i += 2;
      continue;
    }
    if (c === "⇒") {
      result += ":";
      i++;
      continue;
    }
    if (c === "=" && source[i + 1] === ">") {
      result += ":";
      i += 2;
      continue;
    }
    result += c;
    i++;
  }
  return result;
}

function looksLikeJsonOrMap(trimmed: string): boolean {
  const firstChar = trimmed[0];
  if (firstChar === "{" || firstChar === "[") return true;
  return firstChar === "%" && trimmed[1] === "{";
}

export function prettyPrintJsonIfPossible(source: string): string {
  const trimmed = source.trim();
  if (!trimmed || !looksLikeJsonOrMap(trimmed)) return source;
  try {
    return JSON.stringify(JSON.parse(convertElixirMapToJson(trimmed)), null, 2);
  } catch {
    return source;
  }
}

function maybeWrapBareJson(text: string): string {
  const trimmed = text.trim();
  if (!trimmed || !looksLikeJsonOrMap(trimmed)) return text;
  try {
    const formatted = JSON.stringify(
      JSON.parse(convertElixirMapToJson(trimmed)),
      null,
      2
    );
    return "```json\n" + formatted + "\n```";
  } catch {
    return text;
  }
}

/**
 * Scan from `start` (a `{` or `[`) to find the matching close, tracking
 * string and escape state so brackets inside strings don't confuse the
 * counter. Returns the index just past the close, or null if the substring
 * isn't well-balanced.
 */
function findBalancedJsonEnd(text: string, start: number): number | null {
  const open = text[start];
  const close = open === "{" ? "}" : open === "[" ? "]" : "";
  if (!close) return null;
  let depth = 0;
  let inString = false;
  let escape = false;
  for (let i = start; i < text.length; i++) {
    const c = text[i];
    if (escape) {
      escape = false;
      continue;
    }
    if (inString) {
      if (c === "\\") {
        escape = true;
        continue;
      }
      if (c === '"') inString = false;
      continue;
    }
    if (c === '"') {
      inString = true;
      continue;
    }
    if (c === "{" || c === "[") depth++;
    else if (c === "}" || c === "]") {
      depth--;
      if (depth === 0) return c === close ? i + 1 : null;
      if (depth < 0) return null;
    }
  }
  return null;
}

function isPrettyPrintable(value: unknown): boolean {
  if (Array.isArray(value)) return value.length > 0;
  if (typeof value === "object" && value !== null) {
    return Object.keys(value as Record<string, unknown>).length > 0;
  }
  return false;
}

const MIN_INLINE_JSON_LENGTH = 10;

/**
 * Find well-formed JSON objects/arrays embedded in prose and hoist them
 * into fenced ```json``` blocks so the code-block renderer can pretty-print
 * them. Skips content inside existing fenced blocks and inline code spans
 * so we don't double-wrap or break verbatim snippets.
 */
function formatInlineJsonBlocks(text: string): string {
  let result = "";
  let i = 0;
  let inFence = false;

  while (i < text.length) {
    // Fenced code block boundary — consume the fence line and toggle state.
    if (text.startsWith("```", i)) {
      const lineEnd = text.indexOf("\n", i + 3);
      const end = lineEnd === -1 ? text.length : lineEnd + 1;
      result += text.slice(i, end);
      i = end;
      inFence = !inFence;
      continue;
    }

    if (inFence) {
      result += text[i];
      i++;
      continue;
    }

    // Inline code span — pass through verbatim.
    if (text[i] === "`") {
      const end = text.indexOf("`", i + 1);
      if (end !== -1) {
        result += text.slice(i, end + 1);
        i = end + 1;
        continue;
      }
    }

    if (text[i] === "{" || text[i] === "[") {
      const end = findBalancedJsonEnd(text, i);
      if (end !== null && end - i >= MIN_INLINE_JSON_LENGTH) {
        const candidate = text.slice(i, end);
        try {
          const parsed = JSON.parse(candidate);
          if (isPrettyPrintable(parsed)) {
            const formatted = JSON.stringify(parsed, null, 2);
            const leading = result.endsWith("\n\n")
              ? ""
              : result.endsWith("\n") || result.length === 0
                ? "\n"
                : "\n\n";
            result += leading + "```json\n" + formatted + "\n```\n\n";
            i = end;
            continue;
          }
        } catch {
          // Not valid JSON — fall through and emit the raw character.
        }
      }
    }

    result += text[i];
    i++;
  }

  return result;
}

export const MarkdownContent = memo(function MarkdownContent({
  text,
}: MarkdownContentProps) {
  const prepared = formatInlineJsonBlocks(maybeWrapBareJson(text));
  return (
    <div className="markdown-content" data-testid="markdown-content">
      <Markdown remarkPlugins={remarkPlugins} components={components}>
        {prepared}
      </Markdown>
    </div>
  );
});

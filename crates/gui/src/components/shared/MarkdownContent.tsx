import {
  createContext,
  memo,
  useContext,
  useEffect,
  useId,
  useMemo,
  useState,
  type ComponentPropsWithoutRef,
  type ReactNode,
} from "react";
import Markdown, { defaultUrlTransform } from "react-markdown";
import { openUrl } from "@tauri-apps/plugin-opener";
import remarkBreaks from "remark-breaks";
import remarkGfm from "remark-gfm";
import { Prism as SyntaxHighlighter } from "react-syntax-highlighter";
import {
  vs,
  vscDarkPlus,
} from "react-syntax-highlighter/dist/esm/styles/prism";
import { useIsLightTheme } from "../../hooks/useTheme";
import { loadGraphviz } from "../../utils/graphviz";
import { LocalFileReferenceLink } from "./LocalFileReferenceLink";
import { parseLocalFileReference } from "./localFileReference";
import { VtbEntityMarkdownLink } from "./VtbEntityLink";
import { parseVtbEntityHref } from "./vtbEntityLinkTarget";

interface MarkdownContentProps {
  text: string;
  projectPath?: string | null;
  expanded?: boolean;
  onExpandedChange?: (expanded: boolean) => void;
}

const LARGE_CONTENT_CHARACTER_LIMIT = 12_000;
const LARGE_CONTENT_LINE_LIMIT = 240;
const CONTENT_PREVIEW_CHARACTER_LIMIT = 4_000;
const CONTENT_PREVIEW_LINE_LIMIT = 120;

function exceedsLineLimit(text: string, limit: number): boolean {
  let lines = 1;
  for (let index = 0; index < text.length; index++) {
    if (text.charCodeAt(index) === 10 && ++lines > limit) return true;
  }
  return false;
}

function isLargeContent(text: string): boolean {
  return (
    text.length > LARGE_CONTENT_CHARACTER_LIMIT ||
    exceedsLineLimit(text, LARGE_CONTENT_LINE_LIMIT)
  );
}

function contentPreview(text: string): string {
  const characterEnd = Math.min(text.length, CONTENT_PREVIEW_CHARACTER_LIMIT);
  let lineCount = 1;
  let end = characterEnd;

  for (let index = 0; index < characterEnd; index++) {
    if (text.charCodeAt(index) !== 10) continue;
    lineCount++;
    if (lineCount > CONTENT_PREVIEW_LINE_LIMIT) {
      end = index;
      break;
    }
  }

  return text.slice(0, end).trimEnd();
}

function BoundedContent({
  text,
  children,
  expanded,
  onExpandedChange,
}: {
  text: string;
  children: (fullText: string) => ReactNode;
  expanded?: boolean;
  onExpandedChange?: (expanded: boolean) => void;
}) {
  const [localExpanded, setLocalExpanded] = useState(false);
  const contentId = useId();
  const isLarge = isLargeContent(text);
  const controlled = expanded !== undefined && onExpandedChange !== undefined;
  const showFull = controlled ? expanded : localExpanded;

  if (!isLarge) return children(text);

  return (
    <div data-testid="bounded-content" data-content-length={text.length}>
      <button
        type="button"
        className="mb-2 rounded border border-border/60 px-2 py-1 font-mono text-eyebrow text-accent hover:border-accent/50"
        aria-controls={contentId}
        aria-expanded={showFull}
        onClick={(event) => {
          event.stopPropagation();
          const next = !showFull;
          if (controlled) onExpandedChange(next);
          else setLocalExpanded(next);
        }}
      >
        {showFull
          ? "Show less"
          : `Show full content (${text.length.toLocaleString()} characters)`}
      </button>
      <div id={contentId}>
        {showFull ? (
          children(text)
        ) : (
          <pre
            className="m-0 max-h-48 overflow-auto whitespace-pre-wrap break-words font-inherit text-inherit"
            data-testid="bounded-content-preview"
          >
            {contentPreview(text)}
            {"\n…"}
          </pre>
        )}
      </div>
    </div>
  );
}

const MarkdownProjectRootContext = createContext<string | null>(null);
const MarkdownProjectRootsContext = createContext<readonly string[]>([]);

export function MarkdownProjectRootProvider({
  projectPath,
  projectRoots,
  children,
}: {
  projectPath?: string | null;
  projectRoots?: readonly string[];
  children: ReactNode;
}) {
  const roots = useMemo(
    () =>
      Array.from(
        new Set(
          [projectPath, ...(projectRoots ?? [])].filter(Boolean) as string[]
        )
      ),
    [projectPath, projectRoots]
  );
  return (
    <MarkdownProjectRootContext.Provider value={projectPath ?? null}>
      <MarkdownProjectRootsContext.Provider value={roots}>
        {children}
      </MarkdownProjectRootsContext.Provider>
    </MarkdownProjectRootContext.Provider>
  );
}

const remarkPlugins = [remarkGfm, remarkBreaks];

function createSyntaxTheme(
  baseTheme: { [key: string]: React.CSSProperties },
  background: string
) {
  return {
    ...baseTheme,
    'pre[class*="language-"]': {
      ...(baseTheme['pre[class*="language-"]'] as React.CSSProperties),
      background,
      backgroundColor: "transparent",
      margin: 0,
      borderRadius: "var(--radius-md)",
    },
    'code[class*="language-"]': {
      ...(baseTheme['code[class*="language-"]'] as React.CSSProperties),
      background: "none",
      backgroundColor: "transparent",
    },
  };
}

const darkSyntaxTheme = createSyntaxTheme(vscDarkPlus, "var(--color-bg)");
const lightSyntaxTheme = createSyntaxTheme(vs, "var(--color-bg-2)");

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

interface HighlightedCodeBlockProps {
  language: string;
  source: string;
  diagramError?: string;
}

function HighlightedCodeBlock({
  language,
  source,
  diagramError,
}: HighlightedCodeBlockProps) {
  const hasLanguage = language !== "text";
  const isLightTheme = useIsLightTheme();
  const syntaxTheme = isLightTheme ? lightSyntaxTheme : darkSyntaxTheme;
  const syntaxBlockStyle = {
    ...codeBlockStyle,
    background: isLightTheme ? "var(--color-bg-2)" : "var(--color-bg)",
  };

  return (
    <div
      className={`group relative mb-2 max-w-full min-w-0 overflow-hidden rounded-md border bg-bg ${
        diagramError ? "border-err/50" : "border-border/50"
      }`}
      data-testid={diagramError ? "diagram-fallback" : undefined}
    >
      {(hasLanguage || diagramError) && (
        <div className="flex flex-wrap items-center gap-2 border-b border-border/50 px-3 py-1">
          {hasLanguage && (
            <span className="font-mono text-eyebrow text-fg-mute">
              {language}
            </span>
          )}
          {diagramError && (
            <span className="font-mono text-eyebrow text-err">
              {diagramError}
            </span>
          )}
        </div>
      )}
      <SyntaxHighlighter
        style={syntaxTheme as { [key: string]: React.CSSProperties }}
        language={language}
        PreTag="div"
        customStyle={syntaxBlockStyle}
        codeTagProps={codeTagStyle}
      >
        {source}
      </SyntaxHighlighter>
    </div>
  );
}

type DiagramRenderResult =
  | { status: "rendering" }
  | { status: "rendered"; document: string; frameStyle: React.CSSProperties }
  | { status: "error"; message: string };

type RenderedDiagram = {
  document: string;
  frameStyle: React.CSSProperties;
};

type DiagramRenderer = {
  label: string;
  render?: (source: string, elementId: string) => Promise<RenderedDiagram>;
};

const diagramRenderers: Record<string, DiagramRenderer> = {
  mermaid: {
    label: "Mermaid",
    render: renderMermaidDiagram,
  },
  mmd: {
    label: "Mermaid",
    render: renderMermaidDiagram,
  },
  dot: {
    label: "DOT",
    render: renderDotDiagram,
  },
  graphviz: {
    label: "DOT",
    render: renderDotDiagram,
  },
  d2: { label: "D2" },
  plantuml: { label: "PlantUML" },
  puml: { label: "PlantUML" },
  kroki: { label: "Kroki" },
};

let mermaidInitialized = false;

async function renderDotDiagram(source: string): Promise<RenderedDiagram> {
  const graphviz = await loadGraphviz();
  const svg = graphviz.dot(source);
  const sanitized = sanitizeSvg(svg);
  if (!sanitized) {
    throw new Error("Renderer returned an invalid SVG.");
  }
  return {
    document: buildSandboxedSvgDocument(sanitized.svg),
    frameStyle: diagramFrameStyle(sanitized.size),
  };
}

async function renderMermaidDiagram(
  source: string,
  elementId: string
): Promise<RenderedDiagram> {
  const { default: mermaid } = await import("mermaid");

  if (!mermaidInitialized) {
    mermaid.initialize({
      startOnLoad: false,
      securityLevel: "strict",
      deterministicIds: true,
      deterministicIDSeed: "vertebrae-chat",
      theme: "dark",
      fontFamily: "Inter, ui-sans-serif, system-ui, sans-serif",
      htmlLabels: false,
      flowchart: { htmlLabels: false, useMaxWidth: true },
      sequence: { useMaxWidth: true },
    });
    mermaidInitialized = true;
  }

  await mermaid.parse(source);
  const { svg } = await mermaid.render(elementId, source);
  const sanitized = sanitizeSvg(svg);
  if (!sanitized) {
    throw new Error("Renderer returned an invalid SVG.");
  }
  return {
    document: buildSandboxedSvgDocument(sanitized.svg),
    frameStyle: diagramFrameStyle(sanitized.size),
  };
}

type SvgSize = {
  width: number;
  height: number;
  maxWidth?: number;
};

type SanitizedSvg = {
  svg: string;
  size: SvgSize;
};

function sanitizeSvg(svg: string): SanitizedSvg | null {
  const parser = new DOMParser();
  const document = parser.parseFromString(svg, "image/svg+xml");
  if (document.querySelector("parsererror")) return null;

  const root = document.documentElement;
  if (root.tagName.toLowerCase() !== "svg") return null;
  const size = svgSize(root);

  const blockedElements = new Set([
    "script",
    "foreignobject",
    "iframe",
    "object",
    "embed",
    "audio",
    "video",
    "canvas",
    "link",
    "meta",
  ]);

  const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT);
  const elementsToRemove: Element[] = [];

  sanitizeSvgElement(root);
  while (walker.nextNode()) {
    const element = walker.currentNode as Element;
    if (blockedElements.has(element.tagName.toLowerCase())) {
      elementsToRemove.push(element);
      continue;
    }

    sanitizeSvgElement(element);
  }

  elementsToRemove.forEach((element) => element.remove());
  return { svg: new XMLSerializer().serializeToString(root), size };
}

function sanitizeSvgElement(element: Element): void {
  for (const attribute of Array.from(element.attributes)) {
    const name = attribute.name.toLowerCase();
    const value = attribute.value.trim().toLowerCase();
    const isLocalReference =
      (name === "href" || name === "xlink:href") && value.startsWith("#");
    const isDangerousReference =
      (name === "href" || name === "xlink:href" || name === "src") &&
      !isLocalReference;

    if (
      name.startsWith("on") ||
      isDangerousReference ||
      value.includes("javascript:") ||
      value.includes("data:text/html") ||
      (name === "style" &&
        (value.includes("url(") || value.includes("expression(")))
    ) {
      element.removeAttribute(attribute.name);
    }
  }
}

function buildSandboxedSvgDocument(svg: string): string {
  return `<!doctype html>
<html>
<head>
  <meta charset="utf-8" />
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; img-src data:;" />
  <style>
    html, body { margin: 0; background: transparent; overflow: hidden; }
    svg { display: block; width: 100%; max-width: 100%; height: auto; }
  </style>
</head>
<body>${svg}</body>
</html>`;
}

function parseSvgNumber(value: string | null): number | null {
  if (!value) return null;
  const match = value.trim().match(/^(\d+(?:\.\d+)?)/);
  if (!match) return null;
  const parsed = Number(match[1]);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

function svgMaxWidth(root: Element): number | null {
  const style = root.getAttribute("style");
  const match = style?.match(/(?:^|;)\s*max-width\s*:\s*([^;]+)/i);
  return parseSvgNumber(match?.[1] ?? null);
}

function svgSize(root: Element): SvgSize {
  const maxWidth = svgMaxWidth(root) ?? undefined;
  const viewBox = root
    .getAttribute("viewBox")
    ?.trim()
    .split(/[\s,]+/)
    .map(Number);
  if (
    viewBox?.length === 4 &&
    Number.isFinite(viewBox[2]) &&
    Number.isFinite(viewBox[3]) &&
    viewBox[2] > 0 &&
    viewBox[3] > 0
  ) {
    return { width: viewBox[2], height: viewBox[3], maxWidth };
  }

  const width = parseSvgNumber(root.getAttribute("width"));
  const height = parseSvgNumber(root.getAttribute("height"));
  if (width && height) return { width, height, maxWidth: maxWidth ?? width };

  return { width: 16, height: 9 };
}

function diagramFrameStyle(size: SvgSize): React.CSSProperties {
  const style: React.CSSProperties = {
    aspectRatio: `${size.width} / ${size.height}`,
  };
  if (size.maxWidth) {
    style.maxWidth = `${size.maxWidth}px`;
  }
  return style;
}

function diagramElementId(prefix: string, source: string): string {
  let hash = 0;
  for (let i = 0; i < source.length; i++) {
    hash = (hash * 31 + source.charCodeAt(i)) >>> 0;
  }
  return `${prefix}-${hash.toString(36)}`;
}

function diagramErrorMessage(label: string, error: unknown): string {
  if (error instanceof Error && error.message.trim()) {
    return `Unable to render ${label} diagram: ${error.message}`;
  }
  return `Unable to render ${label} diagram.`;
}

interface DiagramBlockProps {
  language: string;
  source: string;
  renderer: DiagramRenderer;
}

function DiagramBlock({ language, source, renderer }: DiagramBlockProps) {
  const reactId = useId().replace(/[^a-zA-Z0-9_-]/g, "");
  const [result, setResult] = useState<DiagramRenderResult>({
    status: "rendering",
  });

  useEffect(() => {
    if (!renderer.render) {
      setResult({
        status: "error",
        message: `${renderer.label} diagrams are not supported yet.`,
      });
      return;
    }

    let cancelled = false;
    setResult({ status: "rendering" });
    renderer
      .render(source, diagramElementId(`diagram-${reactId}`, source))
      .then(({ document, frameStyle }) => {
        if (!cancelled) setResult({ status: "rendered", document, frameStyle });
      })
      .catch((error: unknown) => {
        if (!cancelled) {
          setResult({
            status: "error",
            message: diagramErrorMessage(renderer.label, error),
          });
        }
      });

    return () => {
      cancelled = true;
    };
  }, [reactId, renderer, source]);

  if (result.status === "error") {
    return (
      <HighlightedCodeBlock
        language={language}
        source={source}
        diagramError={result.message}
      />
    );
  }

  return (
    <div className="mb-2 max-w-full overflow-hidden rounded-md border border-border/50 bg-bg">
      <div className="flex items-center border-b border-border/50 px-3 py-1">
        <span className="font-mono text-eyebrow text-fg-mute">
          {renderer.label}
        </span>
      </div>
      {result.status === "rendering" ? (
        <div className="px-3 py-4 font-mono text-eyebrow text-fg-mute">
          Rendering {renderer.label} diagram...
        </div>
      ) : (
        <iframe
          className="block w-full bg-transparent"
          sandbox=""
          scrolling="no"
          srcDoc={result.document}
          style={result.frameStyle}
          title={`${renderer.label} diagram`}
        />
      )}
    </div>
  );
}

function normalizeCodeLanguage(className?: string): string {
  const match = /language-(\w+)/.exec(className || "");
  return match?.[1]?.toLowerCase() ?? "text";
}

function completedDiagramBlocks(text: string): Set<string> {
  const completed = new Set<string>();
  const openingFence = /(^|\n)(`{3,}|~{3,})([^\n]*)\n/g;
  let match: RegExpExecArray | null;

  while ((match = openingFence.exec(text)) !== null) {
    const fence = match[2];
    const info = match[3].trim();
    const language = info.split(/\s+/)[0]?.toLowerCase() ?? "";
    if (!diagramRenderers[language]) continue;

    const fenceChar = fence[0].replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const closingFence = new RegExp(
      `(^|\\n)${fenceChar}{${fence.length},}[ \\t]*(?=\\n|$)`,
      "g"
    );
    closingFence.lastIndex = openingFence.lastIndex;
    const close = closingFence.exec(text);
    if (!close) continue;

    completed.add(text.slice(openingFence.lastIndex, close.index));
    openingFence.lastIndex = closingFence.lastIndex;
  }

  return completed;
}

function isAbsoluteHttpUrl(href: string | undefined): href is string {
  if (!href || !/^https?:\/\//i.test(href)) return false;

  try {
    const url = new URL(href);
    return (
      (url.protocol === "http:" || url.protocol === "https:") &&
      url.hostname.length > 0
    );
  } catch {
    return false;
  }
}

function markdownUrlTransform(value: string): string {
  if (value.toLowerCase().startsWith("vtb://")) return value;
  return defaultUrlTransform(value);
}

function createMarkdownComponents(
  completedDiagramSources: Set<string>,
  projectPath: string | null,
  projectRoots: readonly string[]
) {
  return {
    p: ({ children, ...props }: ComponentPropsWithoutRef<"p">) => (
      <p
        className="mb-2 text-base leading-relaxed text-fg antialiased last:mb-0"
        {...props}
      >
        {children}
      </p>
    ),
    h1: ({ children, ...props }: ComponentPropsWithoutRef<"h1">) => (
      <h1 className="mb-3 mt-4 text-xl font-bold text-fg first:mt-0" {...props}>
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
    a: ({ children, href, ...props }: ComponentPropsWithoutRef<"a">) => {
      const vtbTarget = parseVtbEntityHref(href);
      if (href?.toLowerCase().startsWith("vtb://")) {
        return vtbTarget ? (
          <VtbEntityMarkdownLink target={vtbTarget}>
            {children}
          </VtbEntityMarkdownLink>
        ) : (
          <span data-testid="vtb-entity-link-fallback" className="text-fg">
            {children ?? href}
          </span>
        );
      }

      const canOpenExternally = isAbsoluteHttpUrl(href);

      return (
        <a
          className={`text-accent underline decoration-accent/30 hover:decoration-accent${
            canOpenExternally ? " cursor-pointer" : ""
          }`}
          {...props}
          href={canOpenExternally ? href : undefined}
          target={canOpenExternally ? "_blank" : undefined}
          rel={canOpenExternally ? "noopener noreferrer" : undefined}
          data-testid={canOpenExternally ? "external-url-link" : undefined}
          data-actionable-reference={
            canOpenExternally ? "external-url" : undefined
          }
          data-external-url={canOpenExternally ? href : undefined}
          onClick={
            canOpenExternally
              ? (event) => {
                  if (event.defaultPrevented || event.button !== 0) {
                    return;
                  }

                  event.preventDefault();
                  event.stopPropagation();
                  void openUrl(href).catch((error) => {
                    console.error("Could not open external URL:", error);
                  });
                }
              : undefined
          }
        >
          {children}
        </a>
      );
    },
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
      <td className="border-t border-border/50 px-3 py-1.5 text-fg" {...props}>
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
      const language = normalizeCodeLanguage(className);
      let codeString = String(children).replace(/\n$/, "");
      const isInlineCode = inline ?? !(className || codeString.includes("\n"));

      if (language === "json") {
        codeString = prettyPrintJsonIfPossible(codeString);
      }

      if (!inline && (className || codeString.includes("\n"))) {
        const renderer = diagramRenderers[language];
        if (renderer && completedDiagramSources.has(codeString)) {
          return (
            <DiagramBlock
              language={language}
              source={codeString}
              renderer={renderer}
            />
          );
        }

        return <HighlightedCodeBlock language={language} source={codeString} />;
      }

      const fileReference =
        isInlineCode &&
        parseLocalFileReference(codeString, projectPath, projectRoots);
      if (fileReference && projectPath) {
        return (
          <LocalFileReferenceLink
            reference={fileReference}
            projectRoot={projectPath}
          >
            {children}
          </LocalFileReferenceLink>
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
}

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

/**
 * Plain tool output uses the same deferred size policy as markdown, but keeps
 * its existing JSON pretty-printing once the user requests the complete body.
 */
export const BoundedTextContent = memo(function BoundedTextContent({
  text,
  expanded,
  onExpandedChange,
}: {
  text: string;
  expanded?: boolean;
  onExpandedChange?: (expanded: boolean) => void;
}) {
  return (
    <BoundedContent
      text={text}
      expanded={expanded}
      onExpandedChange={onExpandedChange}
    >
      {(fullText) => prettyPrintJsonIfPossible(fullText)}
    </BoundedContent>
  );
});

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

function RenderedMarkdownContent({ text, projectPath }: MarkdownContentProps) {
  const inheritedProjectPath = useContext(MarkdownProjectRootContext);
  const inheritedProjectRoots = useContext(MarkdownProjectRootsContext);
  const effectiveProjectPath = projectPath ?? inheritedProjectPath;
  const effectiveProjectRoots = projectPath
    ? [projectPath]
    : inheritedProjectRoots;
  const prepared = formatInlineJsonBlocks(maybeWrapBareJson(text));
  const completedDiagrams = completedDiagramBlocks(prepared);
  const components = createMarkdownComponents(
    completedDiagrams,
    effectiveProjectPath,
    effectiveProjectRoots
  );
  return (
    <Markdown
      remarkPlugins={remarkPlugins}
      components={components}
      urlTransform={markdownUrlTransform}
    >
      {prepared}
    </Markdown>
  );
}

export const MarkdownContent = memo(function MarkdownContent(
  props: MarkdownContentProps
) {
  return (
    <div className="markdown-content" data-testid="markdown-content">
      <BoundedContent
        text={props.text}
        expanded={props.expanded}
        onExpandedChange={props.onExpandedChange}
      >
        {(fullText) => (
          <RenderedMarkdownContent
            text={fullText}
            projectPath={props.projectPath}
          />
        )}
      </BoundedContent>
    </div>
  );
});

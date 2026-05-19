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
    background: "var(--color-bg-primary)",
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
  background: "var(--color-bg-primary)",
  fontSize: "0.8125rem",
  lineHeight: "1.6",
  overflow: "auto",
};

const codeTagStyle = {
  style: { fontFamily: "var(--font-mono)" },
};

const components = {
  p: ({ children, ...props }: ComponentPropsWithoutRef<"p">) => (
    <p
      className="mb-2 text-sm leading-relaxed text-text-primary antialiased last:mb-0"
      {...props}
    >
      {children}
    </p>
  ),
  h1: ({ children, ...props }: ComponentPropsWithoutRef<"h1">) => (
    <h1
      className="mb-3 mt-4 text-xl font-bold text-text-primary first:mt-0"
      {...props}
    >
      {children}
    </h1>
  ),
  h2: ({ children, ...props }: ComponentPropsWithoutRef<"h2">) => (
    <h2
      className="mb-2 mt-3 text-lg font-semibold text-text-primary first:mt-0"
      {...props}
    >
      {children}
    </h2>
  ),
  h3: ({ children, ...props }: ComponentPropsWithoutRef<"h3">) => (
    <h3
      className="mb-2 mt-3 text-base font-semibold text-text-primary first:mt-0"
      {...props}
    >
      {children}
    </h3>
  ),
  h4: ({ children, ...props }: ComponentPropsWithoutRef<"h4">) => (
    <h4
      className="mb-1 mt-2 text-sm font-semibold text-text-primary first:mt-0"
      {...props}
    >
      {children}
    </h4>
  ),
  ul: ({ children, ...props }: ComponentPropsWithoutRef<"ul">) => (
    <ul
      className="mb-2 ml-4 list-disc space-y-1 text-sm text-text-primary"
      {...props}
    >
      {children}
    </ul>
  ),
  ol: ({ children, ...props }: ComponentPropsWithoutRef<"ol">) => (
    <ol
      className="mb-2 ml-4 list-decimal space-y-1 text-sm text-text-primary"
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
  blockquote: ({ children, ...props }: ComponentPropsWithoutRef<"blockquote">) => (
    <blockquote
      className="mb-2 border-l-2 border-primary/50 pl-3 text-text-secondary italic"
      {...props}
    >
      {children}
    </blockquote>
  ),
  a: ({ children, ...props }: ComponentPropsWithoutRef<"a">) => (
    <a
      className="text-primary underline decoration-primary/30 hover:decoration-primary"
      target="_blank"
      rel="noopener noreferrer"
      {...props}
    >
      {children}
    </a>
  ),
  table: ({ children, ...props }: ComponentPropsWithoutRef<"table">) => (
    <div className="mb-2 overflow-x-auto">
      <table
        className="w-full border-collapse text-sm"
        {...props}
      >
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
      className="px-3 py-1.5 text-left text-xs font-medium text-text-secondary"
      {...props}
    >
      {children}
    </th>
  ),
  td: ({ children, ...props }: ComponentPropsWithoutRef<"td">) => (
    <td
      className="border-t border-border/50 px-3 py-1.5 text-text-primary"
      {...props}
    >
      {children}
    </td>
  ),
  hr: (props: ComponentPropsWithoutRef<"hr">) => (
    <hr className="my-3 border-border" {...props} />
  ),
  strong: ({ children, ...props }: ComponentPropsWithoutRef<"strong">) => (
    <strong className="font-semibold text-text-primary" {...props}>
      {children}
    </strong>
  ),
  em: ({ children, ...props }: ComponentPropsWithoutRef<"em">) => (
    <em className="text-text-secondary" {...props}>
      {children}
    </em>
  ),
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  code: ({ inline, className, children, node, ...props }: CodeProps) => {
    const match = /language-(\w+)/.exec(className || "");
    const codeString = String(children).replace(/\n$/, "");

    if (!inline && (match || codeString.includes("\n"))) {
      return (
        <div className="group relative mb-2 overflow-hidden rounded-md border border-border/50 bg-bg-primary">
          {match && (
            <div className="flex items-center border-b border-border/50 px-3 py-1">
              <span className="font-mono text-xs text-text-muted">
                {match[1]}
              </span>
            </div>
          )}
          <SyntaxHighlighter
            style={syntaxTheme as { [key: string]: React.CSSProperties }}
            language={match?.[1] ?? "text"}
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
        className="rounded bg-bg-primary/80 px-1.5 py-0.5 font-mono text-sm text-primary"
        {...props}
      >
        {children}
      </code>
    );
  },
};

export const MarkdownContent = memo(function MarkdownContent({
  text,
}: MarkdownContentProps) {
  return (
    <div className="markdown-content" data-testid="markdown-content">
      <Markdown remarkPlugins={remarkPlugins} components={components}>
        {text}
      </Markdown>
    </div>
  );
});

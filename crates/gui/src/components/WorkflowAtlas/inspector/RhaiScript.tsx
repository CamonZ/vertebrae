import type { CSSProperties } from "react";
import { PrismLight as SyntaxHighlighter } from "react-syntax-highlighter";
import {
  vs,
  vscDarkPlus,
} from "react-syntax-highlighter/dist/esm/styles/prism";
import { useIsLightTheme } from "../../../hooks/useTheme";

type Refractor = { languages: Record<string, unknown> };
const rhai = Object.assign(
  (prism: Refractor) => {
    prism.languages.rhai = {
      comment: [
        { pattern: /\/\*[\s\S]*?\*\//, greedy: true },
        { pattern: /\/\/[^\n]*/ },
      ],
      string: [
        { pattern: /`(?:\\[\s\S]|[^`\\])*`/, greedy: true },
        {
          pattern: /"(?:\\[\s\S]|[^"\\])*"|'(?:\\[\s\S]|[^'\\])*'/,
          greedy: true,
        },
      ],
      keyword:
        /\b(?:as|break|catch|continue|do|else|export|fn|for|if|import|in|let|loop|module|private|return|static|throw|try|type|until|while)\b/,
      boolean: /\b(?:true|false)\b/,
      number:
        /\b(?:0[xX][\da-fA-F_]+|0[bB][01_]+|\d[\d_]*(?:\.\d[\d_]*)?(?:[eE][+-]?\d[\d_]*)?)\b/,
      function: /\b[a-zA-Z_]\w*(?=\s*\()/,
      operator:
        /(?:\?\?|&&|\|\||==|!=|<=|>=|\+=|-=|\*=|\/=|%=|<<|>>>?|->|=>|[+*/%=<>!&|^~-])/,
      punctuation: /(?:[{};,.:]|\[|\]|\(|\))/,
    };
  },
  { displayName: "rhai" }
);

SyntaxHighlighter.registerLanguage("rhai", rhai);

/** Format block layout and indentation while preserving Rhai tokens and literals. */
export function formatRhaiScript(source: string): string {
  const input = source.replace(/\r\n?/g, "\n").trim();
  if (!input) return "";

  let result = "";
  let depth = 0;
  let parens = 0;
  let quote: "'" | '"' | "`" | null = null;
  let lineComment = false;
  let blockComment = false;
  let escaped = false;
  let lineHasContent = false;

  const indent = () => "  ".repeat(Math.max(depth, 0));
  const append = (value: string) => {
    if (!lineHasContent && value !== "\n") result += indent();
    result += value;
    if (value === "\n") lineHasContent = false;
    else if (value.trim()) lineHasContent = true;
  };
  const appendRaw = (value: string) => {
    result += value;
    if (value.endsWith("\n")) lineHasContent = false;
    else if (value.trim()) lineHasContent = true;
  };
  const newline = () => {
    result = result.replace(/[ \t]+$/g, "");
    if (result && !result.endsWith("\n")) result += "\n";
    lineHasContent = false;
  };

  for (let index = 0; index < input.length; index++) {
    const char = input[index];
    const next = input[index + 1];

    if (quote) {
      appendRaw(char);
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === quote) quote = null;
      continue;
    }
    if (lineComment) {
      if (char === "\n") {
        lineComment = false;
        newline();
      } else append(char);
      continue;
    }
    if (blockComment) {
      append(char);
      if (char === "*" && next === "/") {
        append("/");
        index++;
        blockComment = false;
      }
      continue;
    }

    if ((char === "/" && next === "/") || (char === "/" && next === "*")) {
      append(char + next);
      index++;
      if (next === "/") lineComment = true;
      else blockComment = true;
    } else if (char === '"' || char === "'" || char === "`") {
      quote = char;
      append(char);
    } else if (char === "(") {
      parens++;
      append(char);
    } else if (char === ")") {
      parens = Math.max(0, parens - 1);
      append(char);
    } else if (char === "{") {
      if (result.trimEnd().endsWith("#")) append(char);
      else {
        if (lineHasContent && !/[\s]$/.test(result)) append(" ");
        append(char);
      }
      depth++;
      newline();
    } else if (char === "}") {
      newline();
      depth = Math.max(0, depth - 1);
      append(char);
    } else if (char === ";" && parens === 0) {
      append(char);
      newline();
    } else if (char === "\n") {
      newline();
    } else if (/\s/.test(char)) {
      if (lineHasContent && !result.endsWith(" ")) result += " ";
    } else append(char);
  }

  return result.trim();
}

const style: CSSProperties = {
  margin: 0,
  padding: "0.75rem",
  background: "transparent",
  fontSize: "var(--text-13)",
  lineHeight: 1.6,
  overflow: "auto",
  maxHeight: "32rem",
  whiteSpace: "pre",
};

interface RhaiScriptProps {
  source: string;
}

/** Read-only Rhai source view; formatted for display without changing saved code. */
export function RhaiScript({ source }: RhaiScriptProps) {
  const isLightTheme = useIsLightTheme();
  const syntaxTheme = isLightTheme ? vs : vscDarkPlus;
  const formatted = formatRhaiScript(source);
  return (
    <div className="max-h-[32rem] overflow-auto rounded-md border border-border bg-bg font-mono text-xs">
      <SyntaxHighlighter
        language="rhai"
        style={
          {
            ...syntaxTheme,
            'pre[class*="language-"]': {
              ...(syntaxTheme['pre[class*="language-"]'] as CSSProperties),
              background: "transparent",
              margin: 0,
            },
            'code[class*="language-"]': {
              ...(syntaxTheme['code[class*="language-"]'] as CSSProperties),
              background: "none",
            },
          } as { [key: string]: CSSProperties }
        }
        PreTag="div"
        customStyle={style}
        codeTagProps={{ className: "font-mono language-rhai" }}
        data-testid="rhai-script-highlighted"
      >
        {formatted}
      </SyntaxHighlighter>
    </div>
  );
}

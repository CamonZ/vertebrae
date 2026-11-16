import { PanelCode } from "../../shared/PanelCode";

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

/** Read-only formatting never enters the editor or saved source. */
export function RhaiScript({ source }: { source: string }) {
  return (
    <div data-testid="rhai-script-highlighted">
      <PanelCode
        source={formatRhaiScript(source)}
        language="rhai"
        label="Rhai script"
      />
    </div>
  );
}

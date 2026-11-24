#!/usr/bin/env node
// Rejects font sizes in TypeScript sources that bypass the type scale:
// arbitrary text-[Npx] classes, Tailwind size utilities the scale no longer
// defines (they would emit no CSS), and literal inline font sizes. SVG text
// laid out in user units is exempt in the files listed below.
import { readdirSync, readFileSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

const boundary = "(?<![\\w-])";
const end = "(?![\\w-])";

export const CHECKS = [
  {
    pattern: new RegExp(
      `${boundary}text-\\[(?:length:)?[^\\]]*?\\d(?:px|rem|pt)[^\\]]*\\]`,
      "g"
    ),
    message: "arbitrary font size; use text-meta, text-secondary, text-content, text-code or a heading size",
  },
  {
    pattern: new RegExp(
      `${boundary}text-(?:xs|2xs|sm|base|13|eyebrow|[6-9]xl)${end}`,
      "g"
    ),
    message: "retired size utility; the type scale does not define it",
  },
  {
    pattern: /fontSize\s*[:=]\s*\{?\s*["'`]?\d/g,
    message: "literal inline font size; use a type-scale token",
    svgUserUnits: true,
  },
  {
    pattern: /["']--diffs-font-size["']\s*:\s*["'`]\d/g,
    message: "literal diff font size; use var(--text-code)",
  },
];

/** SVG text sized in diagram user units (documented in DESIGN.md). */
export const SVG_USER_UNIT_FILES = new Set([
  "src/components/Artifacts/StatechartViewer.tsx",
]);

export function findFontSizeViolations(source, path) {
  const violations = [];
  for (const { pattern, message, svgUserUnits } of CHECKS) {
    if (svgUserUnits && SVG_USER_UNIT_FILES.has(path)) continue;
    for (const match of source.matchAll(pattern)) {
      const line = source.slice(0, match.index).split("\n").length;
      violations.push({ path, line, text: match[0], message });
    }
  }
  return violations;
}

function* sourceFiles(directory) {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) yield* sourceFiles(path);
    else if (/\.tsx?$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name))
      yield path;
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const root = fileURLToPath(new URL("..", import.meta.url));
  const violations = [];
  for (const file of sourceFiles(join(root, "src"))) {
    const path = relative(root, file).split(sep).join("/");
    violations.push(...findFontSizeViolations(readFileSync(file, "utf8"), path));
  }
  for (const { path, line, text, message } of violations)
    console.error(`${path}:${line}  ${text}  ${message}`);
  if (violations.length > 0) {
    console.error(`\n${violations.length} font size(s) outside the type scale.`);
    process.exit(1);
  }
}

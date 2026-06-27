export function findBalancedJsonEnd(
  text: string,
  start: number
): number | null {
  const open = text[start];
  const close = open === "{" ? "}" : open === "[" ? "]" : "";
  if (!close) return null;

  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let i = start; i < text.length; i += 1) {
    const char = text[i];

    if (escaped) {
      escaped = false;
      continue;
    }

    if (inString) {
      if (char === "\\") {
        escaped = true;
      } else if (char === '"') {
        inString = false;
      }
      continue;
    }

    if (char === '"') {
      inString = true;
      continue;
    }

    if (char === "{" || char === "[") {
      depth += 1;
    } else if (char === "}" || char === "]") {
      depth -= 1;
      if (depth === 0) return char === close ? i + 1 : null;
      if (depth < 0) return null;
    }
  }

  return null;
}

export function parseJsonFragments(value: string): unknown[] {
  const parsed: unknown[] = [];
  let inString = false;
  let escaped = false;

  for (let i = 0; i < value.length; i += 1) {
    const char = value[i];

    if (escaped) {
      escaped = false;
      continue;
    }

    if (inString) {
      if (char === "\\") {
        escaped = true;
      } else if (char === '"') {
        inString = false;
      }
      continue;
    }

    if (char === '"') {
      inString = true;
      continue;
    }

    if (char !== "{" && char !== "[") continue;

    const end = findBalancedJsonEnd(value, i);
    if (end === null) continue;

    try {
      parsed.push(JSON.parse(value.slice(i, end)));
      i = end - 1;
    } catch {
      // Balanced braces are not necessarily valid JSON; keep scanning.
    }
  }

  return parsed;
}

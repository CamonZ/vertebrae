/**
 * Flow-spec errors. Every error names the spec path it is about
 * (`story[2].steps[0].verb`) and, where a name was not found, the registered
 * alternatives, so an author or agent can fix the spec without reading code.
 */

export interface FlowSpecError {
  /** Dotted/indexed path into the spec, e.g. `rails[1].to`; "" for the document root. */
  readonly path: string;
  readonly message: string;
  /** Registered names the value could have been (sorted). */
  readonly expected?: readonly string[];
}

export class FlowSpecErrors extends Error {
  constructor(readonly errors: readonly FlowSpecError[]) {
    super(errors.map(formatFlowError).join("\n"));
    this.name = "FlowSpecErrors";
  }
}

export function formatFlowError(e: FlowSpecError): string {
  return e.path ? `${e.path}: ${e.message}` : e.message;
}

/** Join a path segment: `join("parts[0]", "kind")` → `parts[0].kind`. */
export function join(path: string, key: string | number): string {
  if (typeof key === "number") return `${path}[${key}]`;
  return path ? `${path}.${key}` : key;
}

/** Edit distance with adjacent transpositions (optimal string alignment), for "did you mean". */
function distance(a: string, b: string): number {
  const d = Array.from({ length: a.length + 1 }, (_, i) =>
    Array.from({ length: b.length + 1 }, (_, j) =>
      i === 0 ? j : j === 0 ? i : 0
    )
  );
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      d[i][j] = Math.min(
        d[i - 1][j] + 1,
        d[i][j - 1] + 1,
        d[i - 1][j - 1] + cost
      );
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1])
        d[i][j] = Math.min(d[i][j], d[i - 2][j - 2] + 1);
    }
  }
  return d[a.length][b.length];
}

/** The closest name within an edit distance of a third of its length. */
export function closest(
  name: string,
  names: readonly string[]
): string | undefined {
  let best: string | undefined;
  let bestD = Infinity;
  for (const n of names) {
    const d = distance(name.toLowerCase(), n.toLowerCase());
    if (d < bestD) {
      best = n;
      bestD = d;
    }
  }
  return best !== undefined && bestD <= Math.max(1, Math.floor(name.length / 3))
    ? best
    : undefined;
}

/** `unknown part kind "wroker" (did you mean "worker"?); registered: a, b`. */
export function notFound(
  what: string,
  name: string,
  names: readonly string[],
  registeredLabel = "registered"
): Omit<FlowSpecError, "path"> {
  const expected = [...names].sort();
  const hint = closest(name, expected);
  const list = expected.length ? expected.join(", ") : "none";
  return {
    message: `${what} "${name}"${hint ? ` (did you mean "${hint}"?)` : ""}; ${registeredLabel}: ${list}`,
    expected,
  };
}

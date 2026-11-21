const kinds = ["call", "render", "schedule", "dispatch", "register"] as const;
type Relationship = (typeof kinds)[number];
type Certainty = "verified" | "ambiguous" | "dynamic";

export interface CallEvidence {
  label: string;
  path: string;
  line: number;
  relationship?: Relationship;
  certainty?: Certainty;
}

export interface CallNode extends CallEvidence {
  children: CallNode[];
}

export interface CallRow {
  old?: CallEvidence;
  new?: CallEvidence;
}

export interface FunctionDiff extends CallRow {
  children: CallRow[];
}

interface CallTree {
  snapshot: string;
  direction: "outgoing" | "incoming";
  root: CallNode;
  incomplete?: string;
}

interface CallDiff {
  base: string;
  target: string;
  rows: FunctionDiff[];
  incomplete?: string;
}

type Parsed<T> = { ok: true; data: T } | { ok: false; message: string };
type RecordValue = Record<string, unknown>;

const commit = /^[0-9a-f]{40}$/i;
export const WORKING_TREE = "working-tree";
const MAX_SOURCE = 65_536;
const MAX_NODES = 160;
const MAX_DEPTH = 12;

function record(value: unknown, label: string): RecordValue {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    throw new Error(`${label} must be a JSON object.`);
  return value as RecordValue;
}

function shortText(value: unknown, label: string, max: number): string {
  if (
    typeof value !== "string" ||
    !value.trim() ||
    value.length > max ||
    /\p{Cc}/u.test(value)
  )
    throw new Error(`${label} must be non-empty text of at most ${max} characters.`);
  return value;
}

function snapshot(value: unknown, label: string, allowWorkingTree: boolean): string {
  if (
    typeof value === "string" &&
    (commit.test(value) || (allowWorkingTree && value === WORKING_TREE))
  )
    return value;
  throw new Error(`${label} must be a full commit ID${allowWorkingTree ? ' or "working-tree"' : ""}.`);
}

function evidence(value: unknown): CallEvidence {
  const node = record(value, "Call evidence");
  const label = shortText(node.label, "Call label", 160);
  const path = shortText(node.path, "Source path", 512);
  if (/[\\:]/.test(path) || path.startsWith("~") ||
      path.split("/").some((part) => !part || part === "." || part === ".."))
    throw new Error("Source paths must be relative to the checkout.");
  const line = node.line;
  if (typeof line !== "number" || !Number.isSafeInteger(line) || line < 1)
    throw new Error("Source lines must be positive integers.");
  const relationship = kinds.find((kind) => kind === node.relationship);
  if (node.relationship !== undefined && !relationship)
    throw new Error("Unknown call relationship.");
  const certainty = node.certainty;
  if (
    certainty !== undefined &&
    certainty !== "verified" &&
    certainty !== "ambiguous" &&
    certainty !== "dynamic"
  )
    throw new Error("Unknown call certainty.");
  return { label, path, line, relationship, certainty };
}

function children(value: unknown): unknown[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new Error("Call children must be a list.");
  return value;
}

function limit() {
  let count = 0;
  return (depth: number) => {
    if (++count > MAX_NODES || depth > MAX_DEPTH)
      throw new Error(`Call diagrams support up to ${MAX_NODES} nodes and ${MAX_DEPTH} levels.`);
  };
}

function parse<T>(convert: () => T): Parsed<T> {
  try {
    return { ok: true, data: convert() };
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : String(error) };
  }
}

function json(source: string): unknown {
  if (source.length > MAX_SOURCE) throw new Error("Call diagram is too large.");
  return JSON.parse(source);
}

function incomplete(value: unknown): string | undefined {
  return value === undefined ? undefined : shortText(value, "Incomplete-data note", 300);
}

export function parseCallTree(source: string): Parsed<CallTree> {
  return parse(() => {
    const input = record(json(source), "Call tree");
    const check = limit();
    const read = (value: unknown, depth: number): CallNode => {
      check(depth);
      const node = record(value, "Call node");
      return {
        ...evidence(node),
        children: children(node.children).map((child) => read(child, depth + 1)),
      };
    };
    const direction = input.direction ?? "outgoing";
    if (direction !== "outgoing" && direction !== "incoming")
      throw new Error('Call direction must be "outgoing" or "incoming".');
    return {
      snapshot: snapshot(input.snapshot, "Snapshot", true),
      direction,
      root: read(input.root, 1),
      incomplete: incomplete(input.incomplete),
    };
  });
}

function callRow(input: RecordValue): CallRow {
  const old = input.old === undefined ? undefined : evidence(input.old);
  const next = input.new === undefined ? undefined : evidence(input.new);
  if (!old && !next) throw new Error("Each call diff row needs an old or new side.");
  return { old, new: next };
}

export function parseCallDiff(source: string): Parsed<CallDiff> {
  return parse(() => {
    const input = record(json(source), "Call diff");
    const check = limit();
    const rows = children(input.rows);
    if (!rows.length)
      throw new Error("A call diff needs enclosing functions and their call changes.");
    const readFunction = (value: unknown): FunctionDiff => {
      check(1);
      const row = record(value, "Enclosing function");
      const calls = children(row.children);
      if (!calls.length)
        throw new Error("Each enclosing function needs its call changes in children.");
      const functionSides = callRow(row);
      const changes = calls.map((value) => {
        check(2);
        const call = record(value, "Call change");
        if (call.children !== undefined)
          throw new Error("Place call changes directly under their enclosing function.");
        const sides = callRow(call);
        if (sides.old && !functionSides.old || sides.new && !functionSides.new)
          throw new Error("Call changes need an enclosing function on the same side.");
        if (
          sides.old && sides.new &&
          sides.old.label === sides.new.label &&
          (sides.old.relationship ?? "call") === (sides.new.relationship ?? "call")
        )
          throw new Error("Show only added, removed, or replaced calls.");
        return sides;
      });
      return { ...functionSides, children: changes };
    };
    return {
      base: snapshot(input.base, "Base", false),
      target: snapshot(input.target, "Target", true),
      rows: rows.map(readFunction),
      incomplete: incomplete(input.incomplete),
    };
  });
}

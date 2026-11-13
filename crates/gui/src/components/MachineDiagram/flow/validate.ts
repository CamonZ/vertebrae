/**
 * Spec validation against the registries. Errors name the spec path and the
 * registered alternatives; nothing here knows a part kind, verb or
 * attachment kind by name.
 */
import { ATTACHMENT_COMMON_FIELDS } from "./attachments";
import { join, notFound, type FlowSpecError } from "./errors";
import { checkField, checkFields, isRecord, own, withDefaults } from "./fields";
import type { AnyPartKind, FlowRegistry } from "./registry";
import {
  CHANGE_MARKS,
  FLOW_SPEC_VERSION,
  TOKEN_KINDS,
  WIRE_CHANGE_MARKS,
  type TokenKind,
} from "./spec";

const ID = /^[A-Za-z][A-Za-z0-9_-]*$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const TOP_FIELDS = [
  "version",
  "title",
  "arrangements",
  "baseline",
  "parts",
  "rails",
  "regions",
  "cards",
  "story",
  "band",
  "attachments",
];
const PART_FIELDS = [
  "id",
  "kind",
  "label",
  "job",
  "props",
  "change",
  "changeNote",
  "portChanges",
  "stageChanges",
  "before",
  "after",
  "in",
  "arrangement",
  "position",
  "scale",
  "attachments",
  "drill",
];
const RAIL_FIELDS = [
  "id",
  "from",
  "to",
  "label",
  "conditional",
  "change",
  "in",
  "attachments",
];
const REGION_FIELDS = ["id", "label", "parts"];
const CARD_FIELDS = [
  "id",
  "token",
  "label",
  "payload",
  "origin",
  "attachments",
];
const BEAT_FIELDS = ["id", "caption", "steps", "hold", "attachments"];
const STEP_FIELDS = [
  "verb",
  "part",
  "card",
  "via",
  "with",
  "delay",
  "args",
  "checkpoint",
  "change",
  "in",
];
const BAND_FIELDS = ["heading", "rows", "meter"];
const BAND_ROW_FIELDS = ["name", "note", "chips", "beats"];
const BAND_METER_FIELDS = ["label", "marker", "footnote"];
const SIDES = ["before", "after"];
const ARRANGEMENT_FIELDS = ["name", "label"];
const NAMED_OVERRIDE_FIELDS = [
  "props",
  "changeNote",
  "portChanges",
  "stageChanges",
];
const PAYLOAD_FIELDS = ["type", "value", "eventTime", "fields"];
/** Drill-down nesting and total sub-spec limits (YAML aliases can repeat or loop a spec). */
export const MAX_DRILL_DEPTH = 8;
export const MAX_DRILL_SPECS = 64;

class Checker {
  readonly errors: FlowSpecError[] = [];
  /** Specs being checked, outermost first (cycle detection for drill-downs). */
  readonly specs: object[] = [];
  drills = 0;
  constructor(readonly registry: FlowRegistry) {}

  err(path: string, message: string, expected?: readonly string[]) {
    this.errors.push(
      expected ? { path, message, expected } : { path, message }
    );
  }

  missing(
    path: string,
    what: string,
    name: string,
    names: readonly string[],
    label?: string
  ) {
    this.errors.push({ path, ...notFound(what, name, names, label) });
  }

  changeMark(v: unknown, path: string) {
    if (v !== undefined && !CHANGE_MARKS.includes(v as never))
      this.missing(
        path,
        "unknown change mark",
        String(v),
        CHANGE_MARKS,
        "allowed"
      );
  }

  unknownFields(
    obj: Record<string, unknown>,
    allowed: readonly string[],
    path: string
  ) {
    for (const k of Object.keys(obj))
      if (!allowed.includes(k))
        this.missing(join(path, k), "unknown field", k, allowed, "allowed");
  }

  str(
    obj: Record<string, unknown>,
    key: string,
    path: string,
    required = false
  ): string | undefined {
    const v = obj[key];
    if (v === undefined) {
      if (required) this.err(join(path, key), "is required");
      return undefined;
    }
    if (typeof v !== "string" || v === "") {
      this.err(join(path, key), "expected a non-empty string");
      return undefined;
    }
    return v;
  }

  list(
    obj: Record<string, unknown>,
    key: string,
    path: string,
    required = false
  ): unknown[] {
    const v = obj[key];
    if (v === undefined) {
      if (required) this.err(join(path, key), "is required");
      return [];
    }
    if (!Array.isArray(v)) {
      this.err(join(path, key), "expected a list");
      return [];
    }
    return v;
  }

  id(
    obj: Record<string, unknown>,
    path: string,
    seen: Map<string, string>,
    what: string
  ): string | undefined {
    const id = this.str(obj, "id", path, true);
    if (id === undefined) return undefined;
    if (!ID.test(id)) {
      this.err(
        join(path, "id"),
        `${what} id "${id}" must start with a letter and use letters, digits, - or _`
      );
      return undefined;
    }
    const prev = seen.get(id);
    if (prev) {
      this.err(
        join(path, "id"),
        `duplicate ${what} id "${id}" (first declared at ${prev})`
      );
      return undefined;
    }
    seen.set(id, path);
    return id;
  }

  attachments(obj: Record<string, unknown>, path: string) {
    this.list(obj, "attachments", path).forEach((a, i) => {
      const p = join(join(path, "attachments"), i);
      if (!isRecord(a)) return this.err(p, "expected an attachment object");
      const kind = this.str(a, "kind", p, true);
      if (kind === undefined) return;
      const def = this.registry.attachments.get(kind);
      if (!def)
        return this.missing(
          join(p, "kind"),
          "unknown attachment kind",
          kind,
          this.registry.attachments.kinds()
        );
      const body: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(a))
        if (!own(ATTACHMENT_COMMON_FIELDS, k)) body[k] = v;
      for (const [k, f] of Object.entries(ATTACHMENT_COMMON_FIELDS))
        if (k !== "kind" && a[k] !== undefined)
          checkField(a[k], f, join(p, k), this.errors);
      checkFields(body, def.fields, p, this.errors);
      for (const e of def.check?.(a, p) ?? []) this.err(e.path, e.message);
    });
  }
}

/**
 * A spec's named arrangements while it is checked; absent for the
 * Before/After shorthand. Membership is by part, rail and step: where each
 * is present.
 */
interface Named {
  readonly names: readonly string[];
  readonly baseline: string;
  readonly parts: Map<string, ReadonlySet<string>>;
  readonly rails: Map<string, ReadonlySet<string>>;
}

/** Shorthand-only fields, and what to write instead with named arrangements. */
const SHORTHAND_ONLY: Readonly<Record<string, string>> = {
  change:
    "with named arrangements marks are computed from in: (added: not in the baseline, removed: only in the baseline); list where it is present instead",
  before:
    "before/after overrides are the Before/After shorthand; with named arrangements give them under arrangement: {<name>: {props, changeNote}}",
  after:
    "before/after overrides are the Before/After shorthand; with named arrangements give them under arrangement: {<name>: {props, changeNote}}",
  portChanges:
    "with named arrangements give portChanges per arrangement, under arrangement: {<name>: {portChanges}}",
  stageChanges:
    "with named arrangements give stageChanges per arrangement, under arrangement: {<name>: {stageChanges}}",
};

/** Report shorthand-only fields of a part, rail or step in a named spec. */
function shorthandOnly(
  c: Checker,
  raw: Record<string, unknown>,
  keys: readonly string[],
  p: string
) {
  for (const k of keys)
    if (raw[k] !== undefined) c.err(join(p, k), SHORTHAND_ONLY[k]);
}

/** Report named-only fields in a shorthand spec. */
function namedOnly(
  c: Checker,
  raw: Record<string, unknown>,
  keys: readonly string[],
  p: string
) {
  for (const k of keys)
    if (raw[k] !== undefined)
      c.err(
        join(p, k),
        `${k} names arrangements; it needs a top-level arrangements list`
      );
}

/** The top-level `arrangements` and `baseline`; undefined for the shorthand. */
function checkArrangements(
  c: Checker,
  input: Record<string, unknown>,
  root: string
): Named | undefined {
  if (input.arrangements === undefined) {
    if (input.baseline !== undefined)
      c.err(
        join(root, "baseline"),
        "needs a top-level arrangements list to name the baseline from"
      );
    return undefined;
  }
  const lp = join(root, "arrangements");
  const list = c.list(input, "arrangements", root);
  if (Array.isArray(input.arrangements) && list.length === 0)
    c.err(lp, "needs at least one arrangement");
  const seen = new Map<string, string>();
  list.forEach((raw, i) => {
    const p = join(lp, i);
    let name: unknown = raw;
    let np = p;
    if (isRecord(raw)) {
      c.unknownFields(raw, ARRANGEMENT_FIELDS, p);
      c.str(raw, "label", p);
      if (raw.name === undefined) return c.err(join(p, "name"), "is required");
      name = raw.name;
      np = join(p, "name");
    }
    if (typeof name !== "string" || !ID.test(name))
      return c.err(
        np,
        "expected an arrangement name: a letter, then letters, digits, - or _ (or { name, label })"
      );
    const prev = seen.get(name);
    if (prev !== undefined)
      return c.err(
        np,
        `duplicate arrangement "${name}" (first declared at ${prev})`
      );
    seen.set(name, np);
  });
  const names = [...seen.keys()];
  let baseline = names[0] ?? "";
  const b = c.str(input, "baseline", root);
  if (b !== undefined) {
    if (seen.has(b)) baseline = b;
    else
      c.missing(
        join(root, "baseline"),
        "baseline names missing arrangement",
        b,
        names,
        "arrangements"
      );
  }
  return { names, baseline, parts: new Map(), rails: new Map() };
}

/**
 * An `in` list: known arrangement names, each once. Returns the set given,
 * or undefined when absent (present everywhere it can be) or invalid.
 */
function checkIn(
  c: Checker,
  raw: Record<string, unknown>,
  p: string,
  named: Named
): ReadonlySet<string> | undefined {
  if (raw.in === undefined) return undefined;
  const ip = join(p, "in");
  if (!Array.isArray(raw.in)) {
    c.err(ip, "expected a list of arrangement names");
    return undefined;
  }
  if (raw.in.length === 0) c.err(ip, "needs at least one arrangement");
  const out = new Set<string>();
  raw.in.forEach((a, i) => {
    const ap = join(ip, i);
    if (typeof a !== "string" || a === "")
      return c.err(ap, "expected an arrangement name");
    if (!named.names.includes(a))
      return c.missing(
        ap,
        "unknown arrangement",
        a,
        named.names,
        "arrangements"
      );
    if (out.has(a)) return c.err(ap, `arrangement "${a}" is listed twice`);
    out.add(a);
  });
  return out;
}

/** An error for each arrangement listed in `own` where `what` is absent. */
function presentWithin(
  c: Checker,
  own: ReadonlySet<string> | undefined,
  within: ReadonlySet<string> | undefined,
  p: string,
  what: string
) {
  if (!own || !within) return;
  for (const a of own)
    if (!within.has(a))
      c.err(
        join(p, "in"),
        `lists arrangement "${a}", where ${what} is absent (${what} is in: ${[...within].join(", ") || "none"})`
      );
}

/** An error when a rail or step is in no arrangement at all. */
function presentSomewhere(
  c: Checker,
  members: ReadonlySet<string> | undefined,
  p: string,
  what: string
) {
  if (members && members.size === 0)
    c.err(
      p,
      what === "rail"
        ? "the rail is in no arrangement: its two parts (and its in: list) share none"
        : "the step runs in no arrangement: its part, its via rail and its in: list share none"
    );
}

const intersect = (
  ...sets: (ReadonlySet<string> | undefined)[]
): ReadonlySet<string> | undefined => {
  const given = sets.filter((x): x is ReadonlySet<string> => x !== undefined);
  if (given.length === 0) return undefined;
  return new Set([...given[0]].filter((a) => given.every((g) => g.has(a))));
};

/** Validate a parsed spec (JSON value) against the registries. */
export function validateFlowSpec(
  input: unknown,
  registry: FlowRegistry,
  root = ""
): FlowSpecError[] {
  const c = new Checker(registry);
  check(c, input, root);
  return c.errors;
}

function check(c: Checker, input: unknown, root: string) {
  if (!isRecord(input)) return c.err(root, "a flow spec must be an object");
  c.specs.push(input);
  try {
    checkSpec(c, input, root);
  } finally {
    c.specs.pop();
  }
}

function checkSpec(c: Checker, input: Record<string, unknown>, root: string) {
  c.unknownFields(input, TOP_FIELDS, root);
  if (input.version === undefined)
    c.err(
      join(root, "version"),
      `is required (current version: ${FLOW_SPEC_VERSION})`
    );
  else if (input.version !== FLOW_SPEC_VERSION)
    c.err(
      join(root, "version"),
      `unsupported spec version ${JSON.stringify(input.version)}; supported: ${FLOW_SPEC_VERSION}`,
      [String(FLOW_SPEC_VERSION)]
    );
  if (input.title !== undefined) c.str(input, "title", root);
  c.attachments(input, root);
  const named = checkArrangements(c, input, root);

  /* parts */
  const partIds = new Map<string, string>();
  const parts = new Map<string, { def: AnyPartKind; path: string }>();
  const partsList = c.list(input, "parts", root, true);
  if (Array.isArray(input.parts) && partsList.length === 0)
    c.err(join(root, "parts"), "needs at least one part");
  partsList.forEach((raw, i) => {
    const p = join(join(root, "parts"), i);
    if (!isRecord(raw)) return c.err(p, "expected a part object");
    c.unknownFields(raw, PART_FIELDS, p);
    const id = c.id(raw, p, partIds, "part");
    const kind = c.str(raw, "kind", p, true);
    for (const k of ["label", "job", "changeNote"]) c.str(raw, k, p);
    c.changeMark(raw.change, join(p, "change"));
    if (raw.position !== undefined)
      checkFields(
        raw.position,
        {
          x: { type: "number", required: true },
          y: { type: "number", required: true },
        },
        join(p, "position"),
        c.errors
      );
    if (raw.scale !== undefined)
      checkField(
        raw.scale,
        { type: "number", min: 0.1, max: 4 },
        join(p, "scale"),
        c.errors
      );
    c.attachments(raw, p);
    checkDrill(c, raw, p);
    if (kind === undefined) return;
    const def = c.registry.parts.get(kind);
    if (!def)
      return c.missing(
        join(p, "kind"),
        "unknown part kind",
        kind,
        c.registry.parts.kinds()
      );
    const fields = def.props ?? {};
    checkFields(raw.props, fields, join(p, "props"), c.errors);
    if (named) {
      shorthandOnly(
        c,
        raw,
        ["change", "before", "after", "portChanges", "stageChanges"],
        p
      );
      const members = checkIn(c, raw, p, named);
      checkNamedOverrides(c, raw, def, p, named, members);
      if (id !== undefined) {
        named.parts.set(id, members ?? new Set(named.names));
        parts.set(id, { def, path: p });
      }
      return;
    }
    namedOnly(c, raw, ["in", "arrangement"], p);
    for (const side of ["before", "after"] as const) {
      const o = raw[side];
      if (o === undefined) continue;
      const sp = join(p, side);
      if (!isRecord(o)) {
        c.err(sp, "expected an object with props and/or changeNote");
        continue;
      }
      c.unknownFields(o, ["props", "changeNote"], sp);
      c.str(o, "changeNote", sp);
      // An override updates the base props: resolved props = base + override.
      checkFields(o.props, fields, join(sp, "props"), c.errors, true);
      if (raw.change !== "changed")
        c.err(
          sp,
          `per-arrangement overrides need change: changed (this part is ${String(raw.change ?? "unchanged")})`
        );
    }
    checkInnerMarks(
      c,
      raw,
      def,
      p,
      isRecord(raw.after) && isRecord(raw.after.props)
        ? raw.after.props
        : undefined
    );
    if (id !== undefined) parts.set(id, { def, path: p });
  });

  /* rails */
  const railIds = new Map<string, string>();
  const rails = new Map<
    string,
    { from?: [string, string]; to?: [string, string]; tokens: TokenKind[] }
  >();
  const endpoint = (
    raw: Record<string, unknown>,
    key: "from" | "to",
    p: string
  ): [string, string, readonly TokenKind[]] | undefined => {
    const v = c.str(raw, key, p, true);
    if (v === undefined) return undefined;
    const dot = v.lastIndexOf(".");
    if (dot <= 0 || dot === v.length - 1) {
      c.err(join(p, key), `expected "partId.port", got "${v}"`);
      return undefined;
    }
    const pid = v.slice(0, dot);
    const port = v.slice(dot + 1);
    const part = parts.get(pid);
    if (!part) {
      if (!partIds.has(pid))
        c.missing(
          join(p, key),
          "rail end names missing part",
          pid,
          [...partIds.keys()],
          "parts"
        );
      return undefined;
    }
    const pd = own(part.def.ports, port);
    if (!pd) {
      c.missing(
        join(p, key),
        `missing port on ${pid} (${part.def.kind}):`,
        port,
        Object.keys(part.def.ports),
        "ports"
      );
      return undefined;
    }
    const need = key === "from" ? "out" : "in";
    if (pd.direction !== need && pd.direction !== "both")
      c.err(
        join(p, key),
        `port ${pid}.${port} is an ${pd.direction} port; a rail ${key === "from" ? "leaves from" : "arrives at"} an ${need} port`
      );
    return [pid, port, pd.tokens];
  };
  c.list(input, "rails", root).forEach((raw, i) => {
    const p = join(join(root, "rails"), i);
    if (!isRecord(raw)) return c.err(p, "expected a rail object");
    c.unknownFields(raw, RAIL_FIELDS, p);
    const id = c.id(raw, p, railIds, "rail");
    if (id !== undefined && partIds.has(id))
      c.err(join(p, "id"), `rail id "${id}" is also a part id`);
    c.str(raw, "label", p);
    const own = named ? checkIn(c, raw, p, named) : undefined;
    if (named) shorthandOnly(c, raw, ["change"], p);
    else namedOnly(c, raw, ["in"], p);
    if (raw.conditional !== undefined)
      checkField(
        raw.conditional,
        { type: "boolean" },
        join(p, "conditional"),
        c.errors
      );
    if (
      !named &&
      raw.change !== undefined &&
      !WIRE_CHANGE_MARKS.includes(raw.change as never)
    )
      c.missing(
        join(p, "change"),
        "unknown wire change mark",
        String(raw.change),
        WIRE_CHANGE_MARKS,
        "allowed (mark a changed connection on its part)"
      );
    c.attachments(raw, p);
    const from = endpoint(raw, "from", p);
    const to = endpoint(raw, "to", p);
    let tokens: TokenKind[] = [];
    if (from && to) {
      tokens = from[2].filter((t) => to[2].includes(t));
      if (tokens.length === 0)
        c.err(
          p,
          `${from[0]}.${from[1]} carries ${from[2].join(", ")} but ${to[0]}.${to[1]} accepts ${to[2].join(", ")}; no token kind can travel this rail`
        );
    }
    if (named) {
      const ends = [from, to].map((e) => e && named.parts.get(e[0]));
      if (from) presentWithin(c, own, ends[0], p, `its part "${from[0]}"`);
      if (to && to[0] !== from?.[0])
        presentWithin(c, own, ends[1], p, `its part "${to[0]}"`);
      const members = intersect(own, ends[0], ends[1]);
      if (from && to) presentSomewhere(c, members, p, "rail");
      if (id !== undefined)
        named.rails.set(id, members ?? new Set(named.names));
    }
    if (id !== undefined)
      rails.set(id, {
        from: from && [from[0], from[1]],
        to: to && [to[0], to[1]],
        tokens,
      });
  });

  /* regions */
  const regionIds = new Map<string, string>();
  const regionOf = new Map<string, string>();
  c.list(input, "regions", root).forEach((raw, i) => {
    const p = join(join(root, "regions"), i);
    if (!isRecord(raw)) return c.err(p, "expected a region object");
    c.unknownFields(raw, REGION_FIELDS, p);
    const id = c.id(raw, p, regionIds, "region");
    if (id !== undefined && (partIds.has(id) || railIds.has(id)))
      c.err(join(p, "id"), `region id "${id}" is also a part or rail id`);
    c.str(raw, "label", p);
    const members = c.list(raw, "parts", p, true);
    if (Array.isArray(raw.parts) && members.length === 0)
      c.err(join(p, "parts"), "needs at least one part");
    members.forEach((m, k) => {
      const mp = join(join(p, "parts"), k);
      if (typeof m !== "string" || m === "")
        return c.err(mp, "expected a part id");
      if (!partIds.has(m))
        return c.missing(
          mp,
          "region names missing part",
          m,
          [...partIds.keys()],
          "parts"
        );
      const prev = regionOf.get(m);
      if (prev !== undefined)
        return c.err(
          mp,
          prev === id
            ? `part "${m}" is listed twice`
            : `part "${m}" is already in region "${prev}"; a part belongs to at most one region`
        );
      regionOf.set(m, id ?? "");
    });
  });

  /* cards */
  const cardIds = new Map<string, string>();
  const cards = new Map<string, TokenKind>();
  c.list(input, "cards", root).forEach((raw, i) => {
    const p = join(join(root, "cards"), i);
    if (!isRecord(raw)) return c.err(p, "expected a card object");
    c.unknownFields(raw, CARD_FIELDS, p);
    const id = c.id(raw, p, cardIds, "card");
    c.str(raw, "label", p);
    const token = c.str(raw, "token", p, true);
    if (token !== undefined && !TOKEN_KINDS.includes(token as TokenKind))
      c.missing(join(p, "token"), "unknown token kind", token, TOKEN_KINDS);
    const origin = c.str(raw, "origin", p);
    if (origin !== undefined && !partIds.has(origin))
      c.missing(
        join(p, "origin"),
        "card origin names missing part",
        origin,
        [...partIds.keys()],
        "parts"
      );
    if (raw.payload !== undefined)
      checkPayload(c, raw.payload, join(p, "payload"));
    c.attachments(raw, p);
    if (
      id !== undefined &&
      token !== undefined &&
      TOKEN_KINDS.includes(token as TokenKind)
    )
      cards.set(id, token as TokenKind);
  });

  /* story */
  const beatIds = new Map<string, string>();
  c.list(input, "story", root).forEach((raw, b) => {
    const p = join(join(root, "story"), b);
    if (!isRecord(raw)) return c.err(p, "expected a beat object");
    c.unknownFields(raw, BEAT_FIELDS, p);
    if (raw.id !== undefined) c.id(raw, p, beatIds, "beat");
    if (raw.caption !== undefined && typeof raw.caption !== "string") {
      if (!isRecord(raw.caption))
        c.err(
          join(p, "caption"),
          named
            ? "expected a string or one per arrangement, by name"
            : "expected a string or { before, after }"
        );
      else if (named)
        for (const [a, v] of Object.entries(raw.caption)) {
          const cp = join(join(p, "caption"), a);
          if (!named.names.includes(a))
            c.missing(
              cp,
              "caption names unknown arrangement",
              a,
              named.names,
              "arrangements"
            );
          else if (typeof v !== "string") c.err(cp, "expected a string");
        }
      else
        checkFields(
          raw.caption,
          { before: { type: "string" }, after: { type: "string" } },
          join(p, "caption"),
          c.errors
        );
    }
    if (raw.hold !== undefined)
      checkField(
        raw.hold,
        { type: "number", min: 0 },
        join(p, "hold"),
        c.errors
      );
    c.attachments(raw, p);
    const steps = c.list(raw, "steps", p);
    if (steps.length === 0 && raw.caption === undefined)
      c.err(p, "a beat needs a caption or at least one step");
    steps.forEach((s, k) =>
      checkStep(
        c,
        s,
        join(join(p, "steps"), k),
        parts,
        partIds,
        rails,
        cards,
        named
      )
    );
  });

  if (input.band !== undefined)
    checkBand(c, input.band, join(root, "band"), beatIds, named);
}

/**
 * A named spec's per-arrangement overrides: `arrangement: {name: {props,
 * changeNote, portChanges, stageChanges}}`, each for an arrangement the part
 * is in; props update the base props, marks name the kind's ports and the
 * stages as that arrangement's props name them.
 */
function checkNamedOverrides(
  c: Checker,
  raw: Record<string, unknown>,
  def: AnyPartKind,
  p: string,
  named: Named,
  members: ReadonlySet<string> | undefined
) {
  const v = raw.arrangement;
  if (v === undefined) return;
  const op = join(p, "arrangement");
  if (!isRecord(v)) return c.err(op, "expected overrides by arrangement name");
  for (const [a, o] of Object.entries(v)) {
    const ap = join(op, a);
    if (!named.names.includes(a)) {
      c.missing(
        ap,
        "override names unknown arrangement",
        a,
        named.names,
        "arrangements"
      );
      continue;
    }
    if (members && !members.has(a))
      c.err(
        ap,
        `the part is not in arrangement "${a}" (in: ${[...members].join(", ")})`
      );
    if (!isRecord(o)) {
      c.err(ap, "expected an object with props and/or changeNote");
      continue;
    }
    c.unknownFields(o, NAMED_OVERRIDE_FIELDS, ap);
    c.str(o, "changeNote", ap);
    checkFields(o.props, def.props ?? {}, join(ap, "props"), c.errors, true);
    checkInnerMarks(
      c,
      o,
      def,
      ap,
      isRecord(o.props) ? o.props : undefined,
      isRecord(raw.props) ? raw.props : undefined
    );
  }
}

/** A band: heading, rows naming story beats by id, and an optional meter. */
function checkBand(
  c: Checker,
  raw: unknown,
  p: string,
  beatIds: Map<string, string>,
  named: Named | undefined
) {
  if (!isRecord(raw)) return c.err(p, "expected a band object with rows");
  c.unknownFields(raw, BAND_FIELDS, p);
  c.str(raw, "heading", p);
  const rows = c.list(raw, "rows", p, true);
  if (Array.isArray(raw.rows) && rows.length === 0)
    c.err(join(p, "rows"), "needs at least one row");
  rows.forEach((row, i) => {
    const rp = join(join(p, "rows"), i);
    if (!isRecord(row)) return c.err(rp, "expected a band row object");
    c.unknownFields(row, BAND_ROW_FIELDS, rp);
    c.str(row, "name", rp, true);
    perArrangement(c, row, "note", rp, named, (v, vp) => {
      if (typeof v !== "string" || v === "")
        c.err(vp, "expected a non-empty string");
    });
    if (row.chips === undefined) c.err(join(rp, "chips"), "is required");
    else
      perArrangement(c, row, "chips", rp, named, (v, vp) => {
        if (!Array.isArray(v))
          return c.err(vp, "expected a list of chip texts");
        if (v.length === 0) return c.err(vp, "needs at least one chip");
        v.forEach((chip, k) => {
          if (typeof chip !== "string" || chip === "")
            c.err(join(vp, k), "expected a non-empty string");
        });
      });
    const beats = c.list(row, "beats", rp, true);
    if (Array.isArray(row.beats) && beats.length === 0)
      c.err(join(rp, "beats"), "needs at least one beat id");
    const seen = new Set<string>();
    beats.forEach((b, k) => {
      const bp = join(join(rp, "beats"), k);
      if (typeof b !== "string" || b === "")
        return c.err(bp, "expected a beat id");
      if (seen.has(b)) return c.err(bp, `beat "${b}" is listed twice`);
      seen.add(b);
      if (!beatIds.has(b))
        c.missing(
          bp,
          "band row names missing beat",
          b,
          [...beatIds.keys()],
          "beat ids"
        );
    });
  });
  const meter = raw.meter;
  if (meter === undefined) return;
  const mp = join(p, "meter");
  if (!isRecord(meter))
    return c.err(mp, "expected a meter object with label and marker");
  c.unknownFields(meter, BAND_METER_FIELDS, mp);
  c.str(meter, "label", mp, true);
  if (Array.isArray(meter.marker)) {
    if (meter.marker.length === 0)
      c.err(join(mp, "marker"), "needs at least one marker kind");
    meter.marker.forEach((k, i) => {
      if (typeof k !== "string" || k === "")
        c.err(join(join(mp, "marker"), i), "expected a marker kind");
    });
  } else c.str(meter, "marker", mp, true);
  c.str(meter, "footnote", mp);
}

/**
 * A field that is either one value or one per arrangement, by name
 * (`{ before, after }` in the shorthand), each checked by `each`. The
 * per-arrangement form gives every arrangement.
 */
function perArrangement(
  c: Checker,
  obj: Record<string, unknown>,
  key: string,
  path: string,
  named: Named | undefined,
  each: (v: unknown, p: string) => void
) {
  const v = obj[key];
  if (v === undefined) return;
  const p = join(path, key);
  if (!isRecord(v)) return each(v, p);
  const sides = named?.names ?? SIDES;
  if (named) {
    for (const a of Object.keys(v))
      if (!sides.includes(a))
        c.missing(join(p, a), "unknown arrangement", a, sides, "arrangements");
  } else c.unknownFields(v, SIDES, p);
  for (const side of sides)
    if (v[side] === undefined)
      c.err(
        join(p, side),
        named
          ? `is required (give every arrangement: ${sides.join(", ")})`
          : "is required (give both before and after)"
      );
    else each(v[side], join(p, side));
}

function checkPayload(c: Checker, v: unknown, p: string) {
  if (!isRecord(v)) return c.err(p, "expected { type, value }");
  c.unknownFields(v, PAYLOAD_FIELDS, p);
  c.str(v, "type", p, true);
  if (!("value" in v)) c.err(join(p, "value"), "is required");
  else if (
    v.value !== null &&
    !["string", "number", "boolean"].includes(typeof v.value)
  )
    c.err(join(p, "value"), "expected a string, number, boolean or null");
  if (
    v.eventTime !== undefined &&
    typeof v.eventTime !== "number" &&
    typeof v.eventTime !== "string"
  )
    c.err(join(p, "eventTime"), "expected seconds or a time label");
  if (v.fields !== undefined) {
    if (!isRecord(v.fields))
      c.err(join(p, "fields"), "expected an object of scalar values");
    else
      for (const [k, x] of Object.entries(v.fields))
        if (x !== null && !["string", "number", "boolean"].includes(typeof x))
          c.err(
            join(join(p, "fields"), k),
            "expected a string, number, boolean or null"
          );
  }
}

function checkDrill(c: Checker, raw: Record<string, unknown>, p: string) {
  const d = raw.drill;
  if (d === undefined) return;
  const dp = join(p, "drill");
  if (!isRecord(d)) return c.err(dp, "expected { spec } or { artifact }");
  c.unknownFields(d, ["spec", "artifact"], dp);
  const hasSpec = d.spec !== undefined;
  const hasArtifact = d.artifact !== undefined;
  if (hasSpec === hasArtifact)
    return c.err(
      dp,
      "give exactly one of spec (inline) or artifact (artifact id)"
    );
  if (hasArtifact) {
    if (typeof d.artifact !== "string" || !UUID.test(d.artifact))
      c.err(join(dp, "artifact"), "expected an artifact id (UUID)");
    return;
  }
  const sp = join(dp, "spec");
  if (c.specs.includes(d.spec as object))
    return c.err(
      sp,
      "drill-down spec contains itself (a recursive YAML alias); a drill-down must be a separate spec"
    );
  if (c.specs.length >= MAX_DRILL_DEPTH)
    return c.err(
      sp,
      `drill-downs nest deeper than ${MAX_DRILL_DEPTH} levels; link a saved flow artifact instead`
    );
  if (++c.drills > MAX_DRILL_SPECS)
    return c.err(
      sp,
      `more than ${MAX_DRILL_SPECS} inline drill-down specs; link saved flow artifacts instead`
    );
  check(c, d.spec, sp);
}

function checkStep(
  c: Checker,
  raw: unknown,
  p: string,
  parts: Map<string, { def: AnyPartKind; path: string }>,
  partIds: Map<string, string>,
  rails: Map<
    string,
    { from?: [string, string]; to?: [string, string]; tokens: TokenKind[] }
  >,
  cards: Map<string, TokenKind>,
  named: Named | undefined
) {
  if (!isRecord(raw)) return c.err(p, "expected a step object");
  c.unknownFields(raw, STEP_FIELDS, p);
  if (named) {
    shorthandOnly(c, raw, ["change"], p);
    const own = checkIn(c, raw, p, named);
    if (typeof raw.part === "string")
      presentWithin(
        c,
        own,
        named.parts.get(raw.part),
        p,
        `its part "${raw.part}"`
      );
    const rail =
      typeof raw.via === "string" ? named.rails.get(raw.via) : undefined;
    if (rail) presentWithin(c, own, rail, p, `its rail "${raw.via}"`);
    const part =
      typeof raw.part === "string" ? named.parts.get(raw.part) : undefined;
    if (part) presentSomewhere(c, intersect(own, part, rail), p, "step");
  } else namedOnly(c, raw, ["in"], p);
  const verb = c.str(raw, "verb", p, true);
  const pid = c.str(raw, "part", p, true);
  const cardId = c.str(raw, "card", p);
  const via = c.str(raw, "via", p);
  c.str(raw, "checkpoint", p);
  if (!named) c.changeMark(raw.change, join(p, "change"));
  if (raw.with !== undefined)
    checkField(raw.with, { type: "boolean" }, join(p, "with"), c.errors);
  if (raw.delay !== undefined)
    checkField(
      raw.delay,
      { type: "number", min: 0 },
      join(p, "delay"),
      c.errors
    );

  const part = pid === undefined ? undefined : parts.get(pid);
  if (pid !== undefined && !part && !partIds.has(pid))
    c.missing(
      join(p, "part"),
      "unknown component",
      pid,
      [...partIds.keys()],
      "parts"
    );

  if (cardId !== undefined) {
    if (!cards.has(cardId))
      c.missing(
        join(p, "card"),
        "unknown card",
        cardId,
        [...cards.keys()],
        "cards"
      );
  }

  if (via !== undefined) {
    const rail = rails.get(via);
    if (!rails.has(via))
      c.missing(
        join(p, "via"),
        "unknown rail",
        via,
        [...rails.keys()],
        "rails"
      );
    else if (rail?.to && pid !== undefined && rail.to[0] !== pid)
      c.err(
        join(p, "via"),
        `rail "${via}" arrives at "${rail.to[0]}", not at "${pid}"`
      );
    if (cardId === undefined)
      c.err(join(p, "via"), "a step that travels a rail needs a card");
    // Token kinds are checked by the compiler: a verb can change a card's token.
  }

  if (!part || verb === undefined) return;
  const v = own(part.def.verbs, verb);
  if (!v) {
    const others = c.registry.parts.reactingTo(verb);
    const base = notFound(
      `${part.def.kind} "${pid}" does not react to verb`,
      verb,
      Object.keys(part.def.verbs),
      "its verbs"
    );
    c.errors.push({
      path: join(p, "verb"),
      ...base,
      message: others.length
        ? `${base.message}; "${verb}" is a verb of: ${others.join(", ")}`
        : base.message,
    });
    return;
  }
  const need = v.card ?? "optional";
  if (need === "required" && cardId === undefined)
    c.err(join(p, "card"), `${part.def.kind} verb "${verb}" needs a card`);
  if (need === "none" && cardId !== undefined)
    c.err(join(p, "card"), `${part.def.kind} verb "${verb}" takes no card`);
  checkFields(raw.args, v.args ?? {}, join(p, "args"), c.errors);
}

/**
 * `portChanges` keys must be the kind's ports and `stageChanges` keys its
 * stages as the arrangement drawing the marks names them: After in the
 * shorthand (`override` is After's props), or the override's own.
 */
function checkInnerMarks(
  c: Checker,
  raw: Record<string, unknown>,
  def: AnyPartKind,
  p: string,
  override: Record<string, unknown> | undefined,
  base: Record<string, unknown> | undefined = isRecord(raw.props)
    ? raw.props
    : undefined
) {
  const marks = (key: string, names: readonly string[], what: string) => {
    const v = raw[key];
    if (v === undefined) return;
    const kp = join(p, key);
    if (!isRecord(v))
      return c.err(kp, `expected an object of ${what} names to change marks`);
    for (const [name, mark] of Object.entries(v)) {
      if (!names.includes(name))
        c.missing(
          join(kp, name),
          `${def.kind} has no ${what}`,
          name,
          names,
          `its ${what}s`
        );
      c.changeMark(mark, join(kp, name));
    }
  };
  marks("portChanges", Object.keys(def.ports), "port");
  if (raw.stageChanges === undefined) return;
  if (!def.stages)
    return c.err(join(p, "stageChanges"), `${def.kind} has no stages to mark`);
  let names: string[] = [];
  try {
    names = def.stages(resolvedProps(def, base, override)).map((s) => s.name);
  } catch {
    // Bad props are reported against props; nothing to match stages against.
    return;
  }
  marks("stageChanges", names, "stage");
}

/** Props with defaults for a part in one arrangement (spec assumed valid). */
export function resolvedProps(
  def: AnyPartKind,
  base: Readonly<Record<string, unknown>> | undefined,
  override: Readonly<Record<string, unknown>> | undefined
): Record<string, unknown> {
  return withDefaults(
    { ...(base ?? {}), ...(override ?? {}) },
    def.props ?? {}
  );
}

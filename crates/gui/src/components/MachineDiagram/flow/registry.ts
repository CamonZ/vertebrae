/**
 * Part and attachment registries. The compiler knows no part kind, verb or
 * attachment kind by name: each part kind declares its props, ports, the
 * verbs it reacts to (with their durations) and how each verb compiles to
 * timeline fragments; each attachment kind declares its fields. Component
 * tickets register their parts here as they land.
 */
import type { BBox } from "../ChangeMark";
import type { Footprint } from "../MachinePart";
import type { StateRole } from "../palette";
import type { Point, PortSide } from "../route";
import {
  card as makeCard,
  type CardOptions,
  type CardPayload,
  type CardSpec,
  type GateSpec,
  type LegInput,
  type TimelineMarker,
} from "../timeline";
import { own, type Fields } from "./fields";
import type { ArrangementName, TokenKind } from "./spec";

export type PortDirection = "in" | "out" | "both";

export interface PortDef {
  readonly side: PortSide;
  /** Where the rail meets the frame, in part space (640×400). */
  readonly x: number;
  readonly y: number;
  readonly direction: PortDirection;
  readonly tokens: readonly TokenKind[];
  /** Conditional lane (deny, undo, resume id). */
  readonly dashed?: boolean;
  readonly description?: string;
}

/** The card a step carries, as the part sees it. */
export interface StepCard {
  readonly id: string;
  readonly token: TokenKind;
  readonly label: string;
  readonly payload?: CardPayload;
  /** Colour role the card has when the step starts. */
  readonly role: StateRole;
}

/** Writes timeline fragments into the part's own timeline, in part space and shared-clock time. */
export interface PartWriter {
  card(spec: CardSpec): void;
  /**
   * The step's card inside the part: id, payload, size and outline follow its
   * token kind; `tags` default to its label over the first leg.
   */
  carry(
    legs: readonly LegInput[],
    born: number,
    dies: number,
    o?: CardOptions & { role?: StateRole }
  ): CardSpec;
  note(t: number, text: string, role?: StateRole): void;
  marker(m: Omit<TimelineMarker, "part">): void;
  /** End a card held in the part (born with `dies: HELD`) at `t`. */
  end(cardId: string, t: number): void;
}

/** `dies` for a card held in a part until a later verb ends it (`PartWriter.end`). */
export const HELD = 1e9;

export interface VerbContext<P, S> {
  /** Step start on the shared diagram clock. */
  readonly t: number;
  readonly arrangement: ArrangementName;
  readonly part: {
    readonly id: string;
    readonly kind: string;
    readonly label: string;
    readonly props: P;
  };
  /** The part's simulation state for this arrangement; verbs mutate it. */
  readonly state: S;
  readonly card?: StepCard;
  /** Port the card arrived on when the step came `via` a rail. */
  readonly entry?: string;
  readonly args: Readonly<Record<string, unknown>>;
  readonly out: PartWriter;
  port(name: string): Point;
}

export interface VerbOutcome {
  /** Overrides the verb's default duration for this step. */
  readonly duration?: number;
  /** Port the card leaves by (the next `via` rail must start at this part). */
  readonly exit?: string;
  /** The card's colour role after the step. */
  readonly role?: StateRole;
  /** The card ends here and cannot travel on. */
  readonly consumed?: boolean;
  /**
   * The card's token kind after the step, keeping its id: a request a worker
   * finishes leaves as a result.
   */
  readonly token?: TokenKind;
}

export interface VerbDef<P = Record<string, unknown>, S = unknown> {
  /** Default duration in seconds, from the part's motion spec. */
  readonly duration: number;
  readonly description?: string;
  /** Whether a step with this verb names a card (default optional). */
  readonly card?: "required" | "optional" | "none";
  /** Token kinds the verb accepts (default: any). */
  readonly tokens?: readonly TokenKind[];
  readonly args?: Fields;
  compile(ctx: VerbContext<P, S>): VerbOutcome | void;
}

export interface PartKindDef<P = Record<string, unknown>, S = unknown> {
  readonly kind: string;
  /** Default job line (name · job). */
  readonly job: string;
  readonly family?: string;
  readonly footprint: Footprint;
  /** Frame bounding box in part space (where change marks sit). */
  readonly bb: BBox;
  /** Status line anchor in part space. */
  readonly status: { readonly x: number; readonly y: number };
  readonly props?: Fields;
  /** Ports by name; may be empty (trace, snapshot, replay). */
  readonly ports: Readonly<Record<string, PortDef>>;
  /** Pill gates where rails meet the frame (VL-05). */
  gates?(props: P): readonly GateSpec[];
  /** Fresh simulation state per arrangement. */
  init?(props: P): S;
  readonly verbs: Readonly<Record<string, VerbDef<P, S>>>;
}

/* eslint-disable @typescript-eslint/no-explicit-any -- registries hold heterogeneous part kinds */
export type AnyPartKind = PartKindDef<any, any>;
/* eslint-enable @typescript-eslint/no-explicit-any */

export class PartRegistry {
  private readonly defs = new Map<string, AnyPartKind>();

  register<P, S>(def: PartKindDef<P, S>): this {
    if (this.defs.has(def.kind))
      throw new Error(`part kind "${def.kind}" is already registered`);
    if (Object.keys(def.verbs).length === 0)
      throw new Error(`part kind "${def.kind}" declares no verbs`);
    this.defs.set(def.kind, def as AnyPartKind);
    return this;
  }

  get(kind: string): AnyPartKind | undefined {
    return this.defs.get(kind);
  }

  kinds(): string[] {
    return [...this.defs.keys()].sort();
  }

  /** Registered part kinds that react to `verb`. */
  reactingTo(verb: string): string[] {
    return this.kinds().filter((k) => own(this.defs.get(k)!.verbs, verb));
  }
}

export interface AttachmentKindDef {
  readonly kind: string;
  readonly description: string;
  readonly fields: Fields;
  /** Extra checks beyond the field schema. */
  check?(
    body: Readonly<Record<string, unknown>>,
    path: string
  ): readonly { path: string; message: string }[];
}

export class AttachmentRegistry {
  private readonly defs = new Map<string, AttachmentKindDef>();

  register(def: AttachmentKindDef): this {
    if (this.defs.has(def.kind))
      throw new Error(`attachment kind "${def.kind}" is already registered`);
    this.defs.set(def.kind, def);
    return this;
  }

  get(kind: string): AttachmentKindDef | undefined {
    return this.defs.get(kind);
  }

  kinds(): string[] {
    return [...this.defs.keys()].sort();
  }
}

export interface FlowRegistry {
  readonly parts: PartRegistry;
  readonly attachments: AttachmentRegistry;
}

/* ---------- token shapes ---------- */

export interface TokenShape {
  readonly w: number;
  readonly h?: number;
  readonly dot: boolean;
  readonly hollow: boolean;
  /** Role while travelling a rail: in-flight work is amber; results and controls keep theirs. */
  readonly role: StateRole;
}

/** Catalogue tokens table: request 28×18, payload 36×23, controls hollow, events and signals dots. */
export const TOKEN_SHAPES: Readonly<Record<TokenKind, TokenShape>> = {
  request: { w: 28, dot: false, hollow: false, role: "amber" },
  data: { w: 28, dot: false, hollow: false, role: "amber" },
  payload: { w: 36, dot: false, hollow: false, role: "amber" },
  result: { w: 28, dot: false, hollow: false, role: "ink" },
  batch: { w: 28, dot: false, hollow: false, role: "amber" },
  copy: { w: 28, dot: false, hollow: false, role: "amber" },
  control: { w: 28, dot: false, hollow: true, role: "ink" },
  event: { w: 14, dot: true, hollow: false, role: "ink" },
  signal: { w: 14, dot: true, hollow: false, role: "ink" },
  token: { w: 18, h: 7, dot: false, hollow: false, role: "ink" },
};

/** CardOptions for a token's shape and identity. */
export function tokenCardOptions(
  c: Pick<StepCard, "id" | "token" | "payload">
): CardOptions {
  const s = TOKEN_SHAPES[c.token];
  return {
    id: c.id,
    ...(c.payload ? { payload: c.payload } : {}),
    ...(s.h !== undefined ? { h: s.h } : {}),
    dot: s.dot,
    hollow: s.hollow,
  };
}

/** Build a card for a step card, used by the part writer and the rail layer. */
export function tokenCard(
  c: StepCard,
  role: StateRole,
  legs: readonly LegInput[],
  born: number,
  dies: number,
  o: CardOptions = {}
): CardSpec {
  return makeCard(TOKEN_SHAPES[c.token].w, role, legs, born, dies, {
    ...tokenCardOptions(c),
    ...o,
  });
}

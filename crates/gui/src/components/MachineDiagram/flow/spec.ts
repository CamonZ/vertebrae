/**
 * The flow spec: a declarative description of a machine diagram that an
 * agent or a person writes, in JSON (or YAML). Parts and rails have stable
 * ids; the story is a list of beats, each a caption plus verbs the parts
 * react to. One spec carries both sides of a change: change marks and
 * per-arrangement props make the same input cards run through the Before and
 * After arrangements, so the difference in outcome is computed, not drawn.
 */
import type { ChangeMark } from "../accessibility";
import type { CardPayload } from "../timeline";

export const FLOW_SPEC_VERSION = 1;

/** Token kinds from the catalogue's tokens table; shape tells them apart, never colour. */
export const TOKEN_KINDS = [
  "request",
  "data",
  "payload",
  "result",
  "batch",
  "copy",
  "control",
  "event",
  "signal",
  "token",
] as const;
export type TokenKind = (typeof TOKEN_KINDS)[number];

export const CHANGE_MARKS: readonly ChangeMark[] = [
  "unchanged",
  "added",
  "changed",
  "removed",
];
/** Wires are marked + or −; a changed connection is marked on its part (catalogue "Change marks"). */
export type WireChangeMark = "unchanged" | "added" | "removed";
export const WIRE_CHANGE_MARKS: readonly WireChangeMark[] = [
  "unchanged",
  "added",
  "removed",
];

export type Arrangement = "before" | "after";
/** A spec without change marks compiles one arrangement, `current`. */
export type ArrangementName = Arrangement | "current";

/** Common to every attachment; the rest of the body is the attachment kind's fields. */
export interface AttachmentSpec {
  readonly kind: string;
  readonly id?: string;
  readonly title?: string;
  /** verified: checked against code or a run; inferred: the author's reading. Default inferred. */
  readonly status?: "verified" | "inferred";
  /** scenario: illustrative story; trace: taken from a recorded run. Default scenario. */
  readonly source?: "scenario" | "trace";
  readonly [field: string]: unknown;
}

export interface Position {
  readonly x: number;
  readonly y: number;
}

/** Per-arrangement overrides for a changed part. */
export interface ArrangementOverride {
  readonly props?: Readonly<Record<string, unknown>>;
  readonly changeNote?: string;
}

/** A deeper diagram behind a part: inline, or a saved flow artifact. */
export type DrillSpec =
  | { readonly spec: FlowSpec }
  | { readonly artifact: string };

export interface PartSpec {
  /** Stable id; rails and steps refer to it. */
  readonly id: string;
  /** A registered part kind, e.g. `worker`, `session`, `event rail`. */
  readonly kind: string;
  /** Instance name drawn above the part (defaults to the kind). */
  readonly label?: string;
  readonly job?: string;
  readonly props?: Readonly<Record<string, unknown>>;
  readonly change?: ChangeMark;
  /** What changed, drawn under the name for `~ changed`. */
  readonly changeNote?: string;
  readonly before?: ArrangementOverride;
  readonly after?: ArrangementOverride;
  /** Hand-given placement of the part's 640×400 cell; auto-layout fills it in when absent. */
  readonly position?: Position;
  /** Cell scale; defaults to the kind's footprint (S 0.5, M 0.75, L 1). */
  readonly scale?: number;
  readonly attachments?: readonly AttachmentSpec[];
  readonly drill?: DrillSpec;
}

export interface RailSpec {
  readonly id: string;
  /** `partId.port` */
  readonly from: string;
  /** `partId.port` */
  readonly to: string;
  readonly label?: string;
  /** Dashed lane that only carries on a condition (VL-05). */
  readonly conditional?: boolean;
  readonly change?: WireChangeMark;
  readonly attachments?: readonly AttachmentSpec[];
}

/**
 * A boundary drawn around parts (process, network, trust zone, container):
 * a dashed region named in its corner. Auto-layout keeps its parts together
 * as one compound node; with hand-given positions it frames them as placed.
 */
export interface RegionSpec {
  readonly id: string;
  /** Region name drawn in the corner, e.g. SACRUM PROCESS. */
  readonly label?: string;
  /** Ids of the parts inside; a part belongs to at most one region. */
  readonly parts: readonly string[];
}

export interface CardDecl {
  readonly id: string;
  readonly token: TokenKind;
  /** Tag text riding above the card (defaults to the id). */
  readonly label?: string;
  readonly payload?: CardPayload;
  /** Part the card starts at, so its first step can travel a rail from there. */
  readonly origin?: string;
  readonly attachments?: readonly AttachmentSpec[];
}

export interface StepSpec {
  readonly verb: string;
  /** The part that reacts. */
  readonly part: string;
  readonly card?: string;
  /** Rail the card travels on to reach `part` before the verb runs. */
  readonly via?: string;
  /** Start together with the previous step instead of after it. */
  readonly with?: boolean;
  /** Extra delay before the step starts, in seconds. */
  readonly delay?: number;
  readonly args?: Readonly<Record<string, unknown>>;
  /** Mark a durable checkpoint on the timeline when the step ends. */
  readonly checkpoint?: string;
}

/** A caption, or one per arrangement when the two sides read differently. */
export type Caption =
  | string
  | { readonly before?: string; readonly after?: string };

export interface BeatSpec {
  readonly id?: string;
  readonly caption?: Caption;
  readonly steps?: readonly StepSpec[];
  /** Seconds to hold after the steps (default 0.3; 1.6 for a caption-only beat). */
  readonly hold?: number;
  readonly attachments?: readonly AttachmentSpec[];
}

export interface FlowSpec {
  readonly version: number;
  readonly title?: string;
  readonly parts: readonly PartSpec[];
  readonly rails?: readonly RailSpec[];
  readonly regions?: readonly RegionSpec[];
  readonly cards?: readonly CardDecl[];
  readonly story?: readonly BeatSpec[];
  readonly attachments?: readonly AttachmentSpec[];
}

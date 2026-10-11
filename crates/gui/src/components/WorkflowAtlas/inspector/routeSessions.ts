/* ──────────────────────────────────────────────────────────────────
   Session directives: route decisions read from Sacrum's opaque
   route_config, and step transitions read from the pipeline summary.

   A route rule or the default decision may carry
   `session: {mode: "new" | "resume" | "fork", step_id?}` choosing how its
   llm_inference destination enters a provider conversation; `step_id` names
   the step whose conversation is resumed or forked and defaults to the
   destination. A decision without one starts a new conversation. A non-route
   step's transition may carry the same directive. The inspector and the
   Atlas only display these; Sacrum validates them.
   ────────────────────────────────────────────────────────────────── */
import type {
  JsonValue,
  SessionDirective as TransitionSession,
} from "../../../bindings";

export type SessionMode = "new" | "resume" | "fork";

export interface SessionDirective {
  mode: SessionMode;
  /** The step whose conversation is resumed or forked; null = destination. */
  stepId: string | null;
}

export interface RouteDecision {
  key: string;
  /** Rule id, or "default". */
  label: string;
  /** Intra-workflow destination step, when the transition is intra_workflow. */
  targetStepId: string | null;
  /** Destination workflow, when the transition is inter_workflow. */
  targetWorkflowId: string | null;
  session: SessionDirective | null;
}

type JsonObject = { [key: string]: JsonValue | undefined };

function asObject(value: JsonValue | undefined): JsonObject | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as JsonObject)
    : null;
}

function asString(value: JsonValue | undefined): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function sessionDirective(
  value: JsonValue | undefined
): SessionDirective | null {
  const session = asObject(value);
  const mode = asString(session?.mode);
  if (mode !== "new" && mode !== "resume" && mode !== "fork") return null;
  return { mode, stepId: asString(session?.step_id) };
}

function decision(
  value: JsonValue | undefined,
  key: string,
  label: string
): RouteDecision | null {
  const object = asObject(value);
  if (!object) return null;
  const transition = asObject(object.transition);
  const type = asString(transition?.type);
  return {
    key,
    label,
    targetStepId:
      type === "intra_workflow" ? asString(transition?.step_id) : null,
    targetWorkflowId:
      type === "inter_workflow" ? asString(transition?.workflow_id) : null,
    session: sessionDirective(object.session),
  };
}

/** Every rule, in order, then the default decision when one is set. */
export function routeDecisions(
  routeConfig: JsonValue | null | undefined
): RouteDecision[] {
  const config = asObject(routeConfig ?? undefined);
  if (!config) return [];
  const rules = Array.isArray(config.rules) ? config.rules : [];
  const decisions = rules.map((rule, index) =>
    decision(rule, `rule-${index}`, asString(asObject(rule)?.id) ?? `#${index}`)
  );
  decisions.push(decision(config.default, "default", "default"));
  return decisions.filter((entry): entry is RouteDecision => entry !== null);
}

/** The step whose conversation a directive continues: its step_id, else the destination. */
export function sessionSourceStepId(entry: RouteDecision): string | null {
  return entry.session?.stepId ?? entry.targetStepId;
}

export interface SessionEntry {
  key: string;
  /** The route step deciding, or the step whose transition carries the directive. */
  fromStepId: string;
  decision: RouteDecision;
  /** `destination`: the decision enters this step; `source`: it continues this step's conversation elsewhere. */
  role: "destination" | "source";
}

/**
 * The route decisions that enter `stepId`, and those that resume or fork
 * `stepId`'s conversation into another step.
 */
export function sessionEntriesFor(
  stepId: string,
  routes: { routeStepId: string; routeConfig: JsonValue | null | undefined }[]
): SessionEntry[] {
  const entries: SessionEntry[] = [];
  for (const { routeStepId, routeConfig } of routes) {
    for (const entry of routeDecisions(routeConfig)) {
      if (entry.targetStepId === stepId) {
        entries.push({
          key: `${routeStepId}:${entry.key}:destination`,
          fromStepId: routeStepId,
          decision: entry,
          role: "destination",
        });
      } else if (entry.session?.stepId === stepId) {
        entries.push({
          key: `${routeStepId}:${entry.key}:source`,
          fromStepId: routeStepId,
          decision: entry,
          role: "source",
        });
      }
    }
  }
  return entries;
}

/**
 * The transitions whose session directive enters `stepId`, and those that
 * resume or fork `stepId`'s conversation into another step. Each is shaped as
 * a decision labelled `transition`.
 */
export function transitionSessionEntriesFor(
  stepId: string,
  steps: {
    stepId: string;
    transitionSessions: Partial<Record<string, TransitionSession>>;
  }[]
): SessionEntry[] {
  const entries: SessionEntry[] = [];
  for (const { stepId: fromStepId, transitionSessions } of steps) {
    for (const [target, session] of Object.entries(transitionSessions)) {
      if (!session) continue;
      const decision: RouteDecision = {
        key: `transition-${target}`,
        label: "transition",
        targetStepId: target,
        targetWorkflowId: null,
        session: { mode: session.mode, stepId: session.step_id },
      };
      if (target === stepId) {
        entries.push({
          key: `${fromStepId}:${decision.key}:destination`,
          fromStepId,
          decision,
          role: "destination",
        });
      } else if (session.step_id === stepId) {
        entries.push({
          key: `${fromStepId}:${decision.key}:source`,
          fromStepId,
          decision,
          role: "source",
        });
      }
    }
  }
  return entries;
}

/**
 * Edge labels for a route step's intra-workflow transitions, keyed by target
 * step id: each decision taking that edge as `<rule> · <mode>` (`new` when
 * the decision has no directive), joined when several share the edge.
 */
export function routeTransitionLabels(
  routeConfig: JsonValue | null | undefined
): Map<string, string> {
  const byTarget = new Map<string, string[]>();
  for (const entry of routeDecisions(routeConfig)) {
    if (!entry.targetStepId) continue;
    const labels = byTarget.get(entry.targetStepId) ?? [];
    labels.push(`${entry.label} · ${entry.session?.mode ?? "new"}`);
    byTarget.set(entry.targetStepId, labels);
  }
  return new Map(
    [...byTarget].map(([target, labels]) => [target, labels.join(", ")])
  );
}

/**
 * Edge labels for a non-route step's transitions, keyed by target step id:
 * the directive's mode, plus ` · <step>` when it continues the conversation of
 * a step other than the destination. Transitions without a directive have no
 * label.
 */
export function transitionSessionLabels(
  sessions: Partial<Record<string, TransitionSession>> | null | undefined,
  stepName: (id: string) => string
): Map<string, string> {
  const labels = new Map<string, string>();
  for (const [target, session] of Object.entries(sessions ?? {})) {
    if (!session) continue;
    labels.set(
      target,
      session.step_id && session.step_id !== target
        ? `${session.mode} · ${stepName(session.step_id)}`
        : session.mode
    );
  }
  return labels;
}

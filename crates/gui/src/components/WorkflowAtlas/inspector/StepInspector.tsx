/* ──────────────────────────────────────────────────────────────────
   Workflow Atlas — Inspector content (step mode).

   Rendered as the CONTENT inside a right-docked FloatingDetailPanel shell. The
   topology shape (ordering, transitions, kind) comes from the pure `AtlasModel`;
   the rich configuration (goal, prompt, agents, skills, model) is fetched live
   via `useStep(stepId)` because `PipelineStep` carries none of it.

   Transitions — the implicit forward step plus every explicit out-edge — are
   clickable so you can walk the topology without leaving the panel.

   Ported from docs/design/wf-detail.jsx (WfInspector, step branch).
   ────────────────────────────────────────────────────────────────── */
import { useMemo } from "react";
import { CloseIcon, IconButton } from "../../panels";
import { useStep } from "../../../hooks";
import { LiquidHighlight } from "../../StepDetail/LiquidHighlight";
import { SchemaTree } from "../../StepDetail/SchemaTree";
import { splitRef, shortId } from "../layout/geometry";
import type { AtlasModel, AtlasWorkflow } from "../layout/types";
import type { AtlasSelection } from "./selection";
import { kindClass } from "./selection";

export interface StepInspectorProps {
  model: AtlasModel;
  workflowId: string;
  /** Bare backend step id (unique within the workflow). */
  stepId: string;
  /** Walk the topology — select another step or a workflow. */
  onSelect: (sel: AtlasSelection) => void;
  /** Close the panel (also reachable via Escape through the glass-panel stack). */
  onClose: () => void;
}

/** A resolved, clickable transition out of the inspected step. */
interface Transition {
  key: string;
  label: string;
  loop: boolean;
  onClick: () => void;
}

function backendTypeForKind(kind: string): string {
  switch (kind) {
    case "eval":
      return "evaluate";
    case "human":
      return "human_input";
    case "wait":
      return "wait_children";
    case "route":
      return "route";
    case "finish":
      return "finish";
    default:
      return "execute";
  }
}

function stepTypeLabelFor(value: unknown): string | null {
  if (typeof value === "string" && value.length > 0) return value;
  if (value === null || typeof value !== "object") return null;
  if (!("unsupported" in value)) return null;

  const unsupported = (value as { unsupported?: unknown }).unsupported;
  return typeof unsupported === "string" && unsupported.length > 0
    ? unsupported
    : null;
}

export function StepInspector({
  model,
  workflowId,
  stepId,
  onSelect,
  onClose,
}: StepInspectorProps) {
  const wfById = useMemo(() => {
    const m = new Map<string, AtlasWorkflow>();
    model.workflows.forEach((w) => m.set(w.id, w));
    return m;
  }, [model.workflows]);

  const wf = wfById.get(workflowId);
  const ref = `${workflowId}.${stepId}`;
  const idx = wf ? wf.stepIds.indexOf(stepId) : -1;
  const step = model.steps.find((s) => s.id === ref) ?? null;

  // Rich config — fetched live; PipelineStep has no goal/prompt/agents/etc.
  const { step: cfg, isLoading } = useStep(stepId);

  const transitions = useMemo<Transition[]>(() => {
    if (!wf || !step) return [];
    if (step.kind === "finish") return [];
    const list: Transition[] = [];
    // implicit forward step (next in order)
    const nextStepId =
      idx >= 0 && idx < wf.stepIds.length - 1 ? wf.stepIds[idx + 1] : null;
    if (nextStepId) {
      const next = model.steps.find((s) => s.id === `${wf.id}.${nextStepId}`);
      list.push({
        key: "next",
        label: next?.name ?? nextStepId,
        loop: false,
        onClick: () =>
          onSelect({ type: "step", workflowId: wf.id, stepId: nextStepId }),
      });
    }
    // every explicit out-edge (loop within wf, or handoff to another wf)
    for (const e of model.edges) {
      if (e.from !== ref) continue;
      const [tw, ts] = splitRef(e.to);
      const loop = tw === wf.id;
      // loop → name the target step (ts is a bare step id); handoff → name the
      // target workflow. Fall back to the raw id only if it can't be resolved.
      const label = loop
        ? (model.steps.find((s) => s.id === `${wf.id}.${ts}`)?.name ?? ts)
        : (wfById.get(tw)?.name ?? tw);
      list.push({
        key: e.id,
        label,
        loop,
        onClick: () =>
          loop
            ? onSelect({ type: "step", workflowId: wf.id, stepId: ts })
            : onSelect({ type: "workflow", workflowId: tw }),
      });
    }
    return list;
  }, [model.edges, model.steps, wf, step, idx, ref, wfById, onSelect]);

  if (!wf || !step) return null;

  const kindCls = kindClass(step.kind);
  const isFinal = step.isFinal;
  const isFinish = step.kind === "finish";
  const isTerminal = isFinal || isFinish;
  const agents = cfg?.agents ?? [];
  const skills = cfg?.skills ?? [];
  const model_ = cfg?.agent_config?.model ?? null;
  const stepTypeLabel =
    stepTypeLabelFor(step.stepType) ??
    stepTypeLabelFor(cfg?.step_type) ??
    backendTypeForKind(step.kind);

  return (
    <div className={"wfd kindspine " + kindCls} data-no-pan>
      <div className="wfd-hd">
        <div className="wfd-hd-top">
          <span className="wfd-eyebrow">
            <span className="dot" />
            Step Configuration
          </span>
          <span className="wfd-close">
            <IconButton onClick={onClose} ariaLabel="Close panel">
              <CloseIcon />
            </IconButton>
          </span>
        </div>
        <div className="wfd-step-id">
          <span className={"wfd-num " + kindCls}>{idx + 1}</span>
          <div className="wfd-step-name">
            <div className="wfd-title mono">{step.name}</div>
            <div className="wfd-hash">{shortId(ref)}</div>
          </div>
        </div>
      </div>

      <div className="wfd-body">
        <section className="wfd-sec">
          <div className="wfd-lbl">Goal</div>
          {cfg?.goal ? (
            <div className="wfd-text">{cfg.goal}</div>
          ) : (
            <div className="wfd-placeholder">
              {isLoading ? "Loading…" : "No goal set"}
            </div>
          )}
        </section>

        <section className="wfd-sec">
          <div className="wfd-lbl">Prompt</div>
          {cfg?.prompt ? (
            <pre className="wfd-prompt">
              <LiquidHighlight source={cfg.prompt} />
            </pre>
          ) : (
            <div className="wfd-placeholder">
              {isLoading
                ? "Loading…"
                : isFinish
                  ? "No prompt — completes task immediately"
                  : "No prompt"}
            </div>
          )}
        </section>

        <section className="wfd-sec">
          <div className="wfd-lbl">Overview</div>
          <div className="wfd-rows">
            <div className="wfd-row">
              <span className="rk">Type</span>
              <span
                data-testid="step-type-badge"
                className={"wfd-tag " + kindCls}
              >
                {stepTypeLabel}
              </span>
            </div>
            <div className="wfd-row">
              <span className="rk">Order</span>
              <span className="wfd-pill">{step.order}</span>
            </div>
            <div className="wfd-row">
              <span className="rk">{isFinish ? "Terminal step" : "Final step"}</span>
              <span className={"wfd-toggle" + (isTerminal ? " on" : "")}>
                <span className="knob" />
              </span>
            </div>
            <div className="wfd-row">
              <span className="rk">Tasks parked</span>
              <span className="wfd-pill">{step.total}</span>
            </div>
            <div className="wfd-row">
              <span className="rk">Running</span>
              {step.running > 0 ? (
                <span className="wfd-status live">
                  <span className="pulse" />
                  {step.running}
                </span>
              ) : (
                <span className="wfd-pill">0</span>
              )}
            </div>
          </div>
        </section>

        <section className="wfd-sec">
          <div className="wfd-lbl">
            Agents <span className="n">{agents.length}</span>
          </div>
          {agents.length ? (
            <div className="wfd-chiprow">
              {agents.map((a) => (
                <span key={a} className="wfd-chip">
                  {a}
                </span>
              ))}
            </div>
          ) : (
            <div className="wfd-placeholder">No agents</div>
          )}
        </section>

        <section className="wfd-sec">
          <div className="wfd-lbl">
            Skills <span className="n">{skills.length}</span>
          </div>
          {skills.length ? (
            <div className="wfd-chiprow">
              {skills.map((s) => (
                <span key={s} className="wfd-chip">
                  {s}
                </span>
              ))}
            </div>
          ) : (
            <div className="wfd-placeholder">No skills</div>
          )}
        </section>

        <section className="wfd-sec">
          <div className="wfd-lbl">
            Transitions <span className="n">{transitions.length}</span>
          </div>
          {transitions.length ? (
            <div className="wfd-chiprow">
              {transitions.map((tr) => (
                <button
                  key={tr.key}
                  className={"wfd-trans" + (tr.loop ? " loop" : "")}
                  onClick={tr.onClick}
                  type="button"
                >
                  <span className="arr">→</span>
                  {tr.label}
                </button>
              ))}
            </div>
          ) : (
            <div className="wfd-placeholder">Terminal — no transitions</div>
          )}
        </section>

        <section className="wfd-sec">
          <div className="wfd-lbl">Model</div>
          <div className="wfd-row">
            <span className="rk">Primary</span>
            {model_ ? (
              <span className="wfd-pill">{model_}</span>
            ) : (
              <span className="wfd-placeholder">none</span>
            )}
          </div>
        </section>

        <section className="wfd-sec">
          <div className="wfd-lbl">Output Schema</div>
          {cfg?.output_schema ? (
            <SchemaTree schema={cfg.output_schema as Record<string, unknown>} />
          ) : (
            <div className="wfd-placeholder">
              {isLoading ? "Loading…" : "No output schema"}
            </div>
          )}
        </section>
      </div>
    </div>
  );
}

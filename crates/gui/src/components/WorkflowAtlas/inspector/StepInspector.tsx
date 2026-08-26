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
import { useEffect, useMemo, useState } from "react";
import { CloseIcon, IconButton } from "../../panels";
import { useStep } from "../../../hooks";
import { commands, type JsonValue, type StepType } from "../../../bindings";
import { unwrapCommand } from "../../../query";
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
  onDeleted?: () => void;
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
    case "stop":
      return "stop";
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
  onDeleted,
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
  const [editing, setEditing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [goal, setGoal] = useState("");
  const [prompt, setPrompt] = useState("");
  const [type, setType] = useState<StepType>("execute");
  const [agentsText, setAgentsText] = useState("");
  const [skillsText, setSkillsText] = useState("");
  const [transitionsTo, setTransitionsTo] = useState("");
  const [modelValue, setModelValue] = useState("");
  const [outputSchema, setOutputSchema] = useState("");
  const [persistenceOptions, setPersistenceOptions] = useState("");

  useEffect(() => {
    if (!cfg || editing) return;
    setName(cfg.name);
    setGoal(cfg.goal ?? "");
    setPrompt(cfg.prompt ?? "");
    setType(cfg.step_type ?? "execute");
    setAgentsText((cfg.agents ?? []).join(", "));
    setSkillsText((cfg.skills ?? []).join(", "));
    setTransitionsTo((cfg.transitions_to ?? []).join(", "));
    setModelValue(cfg.agent_config?.model ?? "");
    setOutputSchema(
      cfg.output_schema ? JSON.stringify(cfg.output_schema, null, 2) : ""
    );
    setPersistenceOptions(
      cfg.persistence_options
        ? JSON.stringify(cfg.persistence_options, null, 2)
        : ""
    );
  }, [cfg, editing]);

  const transitions = useMemo<Transition[]>(() => {
    if (!wf || !step) return [];
    const list: Transition[] = [];
    // implicit forward step (next in order)
    const nextStepId =
      idx >= 0 && idx < wf.stepIds.length - 1 ? wf.stepIds[idx + 1] : null;
    if (nextStepId && step.kind !== "finish" && step.kind !== "stop") {
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

    // Forward intra-workflow edges are intentionally omitted from AtlasModel
    // because ordinary steps already expose their implicit next step. A stop
    // boundary has no implicit continuation, so surface its explicit target.
    if (step.kind === "stop") {
      for (const targetId of step.transitionsTo) {
        const key = `${ref}->${wf.id}.${targetId}`;
        if (list.some((transition) => transition.key === key)) continue;
        list.push({
          key,
          label:
            model.steps.find(
              (candidate) => candidate.id === `${wf.id}.${targetId}`
            )?.name ?? targetId,
          loop: false,
          onClick: () =>
            onSelect({ type: "step", workflowId: wf.id, stepId: targetId }),
        });
      }
    }
    return list;
  }, [model.edges, model.steps, wf, step, idx, ref, wfById, onSelect]);

  if (!wf || !step) return null;

  const kindCls = kindClass(step.kind);
  const isFinish = step.kind === "finish";
  const isStop = step.kind === "stop";
  const agents = cfg?.agents ?? [];
  const skills = cfg?.skills ?? [];
  const model_ = cfg?.agent_config?.model ?? null;
  const stepTypeLabel =
    stepTypeLabelFor(step.stepType) ??
    stepTypeLabelFor(cfg?.step_type) ??
    backendTypeForKind(step.kind);

  const listValue = (value: string) =>
    value
      .split(/[\n,]/)
      .map((item) => item.trim())
      .filter(Boolean);

  const save = async () => {
    const nextTransitions = listValue(transitionsTo);
    if (type === "stop" && nextTransitions.length !== 1) {
      setError("Stop steps require exactly one outgoing transition.");
      return;
    }

    let parsedSchema: JsonValue | null = null;
    if (outputSchema.trim()) {
      try {
        parsedSchema = JSON.parse(outputSchema) as JsonValue;
      } catch {
        setError("Output schema must be valid JSON.");
        return;
      }
    }

    let parsedPersistence: JsonValue | null = null;
    let clearPersistenceOptions = !persistenceOptions.trim();
    if (persistenceOptions.trim()) {
      try {
        parsedPersistence = JSON.parse(persistenceOptions) as JsonValue;
      } catch {
        setError("Persistence options must be valid JSON.");
        return;
      }
      if (
        parsedPersistence === null ||
        typeof parsedPersistence !== "object" ||
        Array.isArray(parsedPersistence)
      ) {
        setError(
          "Persistence options must be an artifact configuration object."
        );
        return;
      }
      const artifact = (parsedPersistence as Record<string, JsonValue>)
        .artifact;
      const logicalName =
        artifact && typeof artifact === "object" && !Array.isArray(artifact)
          ? (artifact as Record<string, JsonValue>).logical_name
          : undefined;
      if (
        Object.keys(parsedPersistence as Record<string, JsonValue>).length !==
          1 ||
        !artifact ||
        typeof artifact !== "object" ||
        Array.isArray(artifact) ||
        Object.keys(artifact as Record<string, JsonValue>).length !== 1 ||
        typeof logicalName !== "string" ||
        !logicalName.trim()
      ) {
        setError(
          'Persistence options must match {"artifact":{"logical_name":"..."}}.'
        );
        return;
      }
      if (!outputSchema.trim()) {
        setError("Artifact persistence requires an output schema.");
        return;
      }
      if (type === "finish" || type === "stop") {
        setError("Finish and stop steps cannot persist artifacts.");
        return;
      }
      clearPersistenceOptions = false;
    }

    setSaving(true);
    setError(null);
    try {
      await unwrapCommand(
        commands.updateStep({
          step_id: stepId,
          name,
          goal,
          prompt,
          agents: listValue(agentsText),
          skills: listValue(skillsText),
          agent_config: cfg?.agent_config
            ? { ...cfg.agent_config, model: modelValue || null }
            : undefined,
          step_type: type,
          output_schema: parsedSchema,
          clear_output_schema: !outputSchema.trim(),
          persistence_options: parsedPersistence,
          clear_persistence_options: clearPersistenceOptions,
          order: step.order,
          transitions_to: nextTransitions,
        })
      );
      setEditing(false);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setSaving(false);
    }
  };

  const remove = async () => {
    if (!window.confirm(`Delete step “${step.name}”?`)) return;
    setSaving(true);
    setError(null);
    try {
      await unwrapCommand(commands.deleteStep(stepId));
      onDeleted?.();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className={"wfd kindspine " + kindCls} data-no-pan>
      <div className="wfd-hd">
        <div className="wfd-hd-top">
          <span className="wfd-eyebrow">
            <span className="dot" />
            Step Configuration
          </span>
          <button
            className="wfd-action"
            onClick={() => setEditing((value) => !value)}
            type="button"
          >
            {editing ? "Cancel" : "Edit"}
          </button>
          <button className="wfd-action danger" onClick={remove} type="button">
            Delete
          </button>
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

      {editing ? (
        <section className="wfd-sec wfd-editor" data-testid="step-editor">
          <div className="wfd-lbl">Edit step</div>
          <label>
            Name
            <input value={name} onChange={(e) => setName(e.target.value)} />
          </label>
          <label>
            Type
            <select
              value={typeof type === "string" ? type : "execute"}
              onChange={(e) => setType(e.target.value as StepType)}
            >
              <option value="execute">execute</option>
              <option value="evaluate">evaluate</option>
              <option value="route">route</option>
              <option value="wait_children">wait_children</option>
              <option value="human_input">human_input</option>
              <option value="stop">stop</option>
              <option value="finish">finish</option>
            </select>
          </label>
          <label>
            Goal
            <textarea value={goal} onChange={(e) => setGoal(e.target.value)} />
          </label>
          <label>
            Prompt
            <textarea
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              placeholder={
                isStop
                  ? "Not dispatched for a stop boundary"
                  : "Optional prompt"
              }
            />
          </label>
          <label>
            Agents <span className="wfd-help">comma or newline separated</span>
            <input
              value={agentsText}
              onChange={(e) => setAgentsText(e.target.value)}
            />
          </label>
          <label>
            Skills <span className="wfd-help">comma or newline separated</span>
            <input
              value={skillsText}
              onChange={(e) => setSkillsText(e.target.value)}
            />
          </label>
          <label>
            Model
            <input
              value={modelValue}
              onChange={(e) => setModelValue(e.target.value)}
            />
          </label>
          <label>
            Transitions{" "}
            <span className="wfd-help">stop requires exactly one</span>
            <input
              value={transitionsTo}
              onChange={(e) => setTransitionsTo(e.target.value)}
            />
          </label>
          <label>
            Output schema
            <textarea
              value={outputSchema}
              onChange={(e) => setOutputSchema(e.target.value)}
              placeholder="JSON Schema (optional)"
            />
          </label>
          <label>
            Persistence options
            <textarea
              value={persistenceOptions}
              onChange={(e) => setPersistenceOptions(e.target.value)}
              placeholder='{"artifact":{"logical_name":"result"}}'
            />
          </label>
          {error ? <div className="wfd-error">{error}</div> : null}
          <button
            className="wfd-save"
            disabled={saving || !name.trim()}
            onClick={save}
            type="button"
          >
            {saving ? "Saving…" : "Save step"}
          </button>
        </section>
      ) : null}

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
                  : isStop
                    ? "No prompt — run boundary is not dispatched"
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

        <section className="wfd-sec">
          <div className="wfd-lbl">Persistence</div>
          {cfg?.persistence_options ? (
            <pre className="wfd-prompt">
              {JSON.stringify(cfg.persistence_options, null, 2)}
            </pre>
          ) : (
            <div className="wfd-placeholder">
              {isLoading ? "Loading…" : "No persistence configured"}
            </div>
          )}
        </section>
      </div>
    </div>
  );
}

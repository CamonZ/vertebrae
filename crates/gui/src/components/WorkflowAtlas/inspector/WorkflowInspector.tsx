/* ──────────────────────────────────────────────────────────────────
   Workflow Atlas — Inspector content (workflow mode).

   Rendered as the CONTENT inside a right-docked FloatingDetailPanel shell (the
   mount lives in WorkflowAtlas.tsx). Content is tailored to the topology surface,
   computed live from the pure `AtlasModel`. Transitions are clickable so you can
   walk the topology without leaving the panel.

   Per the locked product decisions the stats strip shows only structural counts
   (phase · steps · out · in · loop) — the prototype's fake runs24h / avg
   aggregates are intentionally dropped.

   Ported from docs/design/wf-detail.jsx (WfInspector, workflow branch).
   ────────────────────────────────────────────────────────────────── */
import { useEffect, useMemo, useState, type ReactNode } from "react";
import { CloseIcon, IconButton } from "../../panels";
import { commands, type StepType } from "../../../bindings";
import { unwrapCommand } from "../../../query";
import { splitRef } from "../layout/geometry";
import type { AtlasModel, AtlasWorkflow } from "../layout/types";
import type { AtlasSelection } from "./selection";
import { kindClass } from "./selection";

export interface WorkflowInspectorProps {
  model: AtlasModel;
  workflowId: string;
  /** Walk the topology — select another workflow or a step. */
  onSelect: (sel: AtlasSelection) => void;
  /** Close the panel (also reachable via Escape through the glass-panel stack). */
  onClose: () => void;
  /** Highlight the matching edge in the canvas while a transition row is hovered.
   *  Called with the model edge id on enter, `null` on leave. */
  onHoverEdge?: (edgeId: string | null) => void;
}

/** A directed edge resolved relative to the inspected workflow. */
interface FlowEdge {
  id: string;
  fromStep: string;
  toStep: string;
  fromWorkflow: string;
  toWorkflow: string;
  label: string | null;
}

export function WorkflowInspector({
  model,
  workflowId,
  onSelect,
  onClose,
  onHoverEdge,
}: WorkflowInspectorProps) {
  const wfById = useMemo(() => {
    const m = new Map<string, AtlasWorkflow>();
    model.workflows.forEach((w) => m.set(w.id, w));
    return m;
  }, [model.workflows]);

  const wf = wfById.get(workflowId);
  const [adding, setAdding] = useState(false);
  const [newName, setNewName] = useState("");
  const [newType, setNewType] = useState<StepType>("execute");
  const [newTransition, setNewTransition] = useState("");
  const [addError, setAddError] = useState<string | null>(null);
  const [addingBusy, setAddingBusy] = useState(false);
  const [editingFactory, setEditingFactory] = useState(false);
  const [factoryNameDraft, setFactoryNameDraft] = useState("");
  const [factoryError, setFactoryError] = useState<string | null>(null);
  const [factoryBusy, setFactoryBusy] = useState(false);

  useEffect(() => {
    setFactoryNameDraft(wf?.factoryName ?? "");
    setEditingFactory(false);
    setFactoryError(null);
  }, [wf?.id, wf?.factoryName]);

  // Resolve the workflow's outgoing / incoming handoffs and same-workflow
  // loop-backs from the model edges. Endpoints are `wf.step` refs.
  const { out, inb, loops } = useMemo(() => {
    const out: FlowEdge[] = [];
    const inb: FlowEdge[] = [];
    const loops: FlowEdge[] = [];
    if (!wf) return { out, inb, loops };
    for (const e of model.edges) {
      const [fw, fs] = splitRef(e.from);
      const [tw, ts] = splitRef(e.to);
      const edge: FlowEdge = {
        id: e.id,
        fromStep: fs,
        toStep: ts,
        fromWorkflow: fw,
        toWorkflow: tw,
        label: e.label,
      };
      if (fw === wf.id && tw === wf.id) loops.push(edge);
      else if (fw === wf.id) out.push(edge);
      else if (tw === wf.id) inb.push(edge);
    }
    return { out, inb, loops };
  }, [model.edges, wf]);

  // Ordered steps for the kind-colored list.
  const steps = useMemo(() => {
    if (!wf) return [];
    return wf.stepIds
      .map((sid) => model.steps.find((s) => s.id === `${wf.id}.${sid}`))
      .filter((s): s is NonNullable<typeof s> => !!s);
  }, [model.steps, wf]);

  // Resolve a bare step id to its human name (loop-backs reference steps in this
  // workflow). Falls back to the id only if a step somehow isn't found.
  const stepName = useMemo(() => {
    const byId = new Map(steps.map((s) => [s.stepId, s.name]));
    return (sid: string) => byId.get(sid) ?? sid;
  }, [steps]);

  if (!wf) return null;

  const selectWf = (id: string) => () =>
    onSelect({ type: "workflow", workflowId: id });
  const selectStep = (stepId: string) => () =>
    onSelect({ type: "step", workflowId: wf.id, stepId });

  const addStep = async () => {
    const transition = newTransition.trim();
    if (!newName.trim()) {
      setAddError("Step name is required.");
      return;
    }
    if (newType === "stop" && !transition) {
      setAddError("Stop steps require exactly one outgoing transition.");
      return;
    }

    setAddingBusy(true);
    setAddError(null);
    try {
      const created = await unwrapCommand(
        commands.createStep({
          workflow_id: wf.id,
          name: newName.trim(),
          goal: null,
          prompt: null,
          agents: [],
          skills: [],
          agent_config: null,
          order: wf.stepIds.length,
          transitions_to: transition ? [transition] : [],
          step_type: newType,
          output_schema: null,
        })
      );
      setNewName("");
      setNewTransition("");
      setAdding(false);
      if (created.id) onSelect({ type: "step", workflowId: wf.id, stepId: created.id });
    } catch (cause) {
      setAddError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setAddingBusy(false);
    }
  };

  const saveFactoryName = async () => {
    const factoryName = factoryNameDraft.trim();
    setFactoryBusy(true);
    setFactoryError(null);
    try {
      await unwrapCommand(
        commands.updateWorkflow({
          workflow_id: wf.id,
          name: null,
          description: null,
          order: null,
          is_default: null,
          kanban_column: null,
          factory_name: factoryName || null,
          clear_factory_name: factoryName.length === 0,
        })
      );
      setEditingFactory(false);
    } catch (cause) {
      setFactoryError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setFactoryBusy(false);
    }
  };

  return (
    <div className="wfd kindspine" data-no-pan>
      <div className="wfd-hd">
        <div className="wfd-hd-top">
          <span className="wfd-eyebrow">
            <span className="dot" />
            Workflow Details · {wf.phase}
          </span>
          {wf.isDefault ? <span className="wfd-badge">default</span> : null}
          <span className={"wfd-status" + (wf.running > 0 ? " live" : "")}>
            {wf.running > 0 ? <span className="pulse" /> : null}
            {wf.running > 0 ? `${wf.running} running` : "idle"}
          </span>
          <span className="wfd-close">
            <IconButton onClick={onClose} ariaLabel="Close panel">
              <CloseIcon />
            </IconButton>
          </span>
        </div>
        <div className="wfd-title">{wf.name}</div>
        <div className="wfd-sub">
          <span>{wf.stepIds.length} steps</span>
          <span className="sep">·</span>
          <span>{out.length} out</span>
          <span className="sep">·</span>
          <span>{inb.length} in</span>
          {loops.length ? (
            <>
              <span className="sep">·</span>
              <span>
                {loops.length} loop-back{loops.length > 1 ? "s" : ""}
              </span>
            </>
          ) : null}
        </div>
      </div>

      <div className="wfd-body">
        {wf.description ? (
          <section className="wfd-sec">
            <div className="wfd-text">{wf.description}</div>
          </section>
        ) : null}

        <section className="wfd-sec">
          <div className="wfd-lbl wfd-lbl-actions">
            <span>Factory name</span>
            <button
              className="wfd-action"
              data-testid="factory-name-edit"
              onClick={() => {
                setFactoryError(null);
                setFactoryNameDraft(wf.factoryName ?? "");
                setEditingFactory((value) => !value);
              }}
              type="button"
            >
              {editingFactory ? "Cancel" : "Edit"}
            </button>
          </div>
          {editingFactory ? (
            <div className="wfd-editor" data-testid="factory-name-editor">
              <label>
                Factory name
                <input
                  aria-label="Factory name"
                  value={factoryNameDraft}
                  onChange={(event) => setFactoryNameDraft(event.target.value)}
                  placeholder="Optional factory name"
                />
              </label>
              {factoryError ? (
                <div className="wfd-error">{factoryError}</div>
              ) : null}
              <div className="wfd-editor-actions">
                <button
                  className="wfd-action"
                  data-testid="factory-name-clear"
                  onClick={() => setFactoryNameDraft("")}
                  type="button"
                >
                  Clear
                </button>
                <button
                  className="wfd-save"
                  data-testid="factory-name-save"
                  disabled={factoryBusy}
                  onClick={saveFactoryName}
                  type="button"
                >
                  {factoryBusy ? "Saving…" : "Save factory name"}
                </button>
              </div>
            </div>
          ) : (
            <div className="wfd-text" data-testid="factory-name-value">
              {wf.factoryName ?? "None"}
            </div>
          )}
        </section>

        <section className="wfd-sec">
          <div className="wfd-stats">
            <div className="wfd-stat">
              <div className="k">phase</div>
              <div className="v sm">{wf.phase}</div>
            </div>
            <div className="wfd-stat">
              <div className="k">steps</div>
              <div className="v">{wf.stepIds.length}</div>
            </div>
            <div className="wfd-stat">
              <div className="k">tasks · running</div>
              <div className="v sm">
                {wf.total} · {wf.running}
              </div>
            </div>
            <div className="wfd-stat">
              <div className="k">out · in</div>
              <div className="v sm">
                {out.length} · {inb.length}
              </div>
            </div>
            <div className="wfd-stat">
              <div className="k">loop-backs</div>
              <div className="v">{loops.length}</div>
            </div>
          </div>
        </section>

        <section className="wfd-sec">
          <div className="wfd-lbl wfd-lbl-actions">
            <span>
              Steps <span className="n">{steps.length}</span>
            </span>
            <button
              className="wfd-action"
              onClick={() => setAdding((value) => !value)}
              type="button"
            >
              {adding ? "Cancel" : "Add step"}
            </button>
          </div>
          {adding ? (
            <div className="wfd-editor" data-testid="step-create-editor">
              <label>
                Name
                <input
                  value={newName}
                  onChange={(event) => setNewName(event.target.value)}
                  placeholder="Step name"
                />
              </label>
              <label>
                Type
                <select
                  value={typeof newType === "string" ? newType : "execute"}
                  onChange={(event) => setNewType(event.target.value as StepType)}
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
                Transition target
                <input
                  value={newTransition}
                  onChange={(event) => setNewTransition(event.target.value)}
                  placeholder={
                    newType === "stop" ? "Required step id" : "Optional step id"
                  }
                />
              </label>
              {addError ? <div className="wfd-error">{addError}</div> : null}
              <button
                className="wfd-save"
                disabled={addingBusy || !newName.trim()}
                onClick={addStep}
                type="button"
              >
                {addingBusy ? "Creating…" : "Create step"}
              </button>
            </div>
          ) : null}
          <div className="wfd-steps">
            {steps.map((s, i) => (
              <button
                key={s.id}
                className={"wfd-step " + kindClass(s.kind)}
                onClick={selectStep(s.stepId)}
                type="button"
              >
                <span className="num">{i + 1}</span>
                <span className="nm">{s.name}</span>
                <span className="kd">{s.kind}</span>
                <span className="arr">›</span>
              </button>
            ))}
          </div>
        </section>

        {loops.length ? (
          <section className="wfd-sec">
            <div className="wfd-lbl">
              Loop-backs <span className="n">{loops.length}</span>
            </div>
            <div className="wfd-flow">
              {loops.map((e) => (
                <FlowRow
                  key={e.id}
                  variant="loop"
                  label={e.label}
                  onClick={selectStep(e.toStep)}
                  edgeId={e.id}
                  onHoverEdge={onHoverEdge}
                >
                  <span>{stepName(e.fromStep)}</span>
                  <span className="arr">→</span>
                  <span className="tgt">{stepName(e.toStep)}</span>
                </FlowRow>
              ))}
            </div>
          </section>
        ) : null}

        <section className="wfd-sec">
          <div className="wfd-lbl">
            Routes out <span className="n">{out.length}</span>
          </div>
          {out.length ? (
            <div className="wfd-flow">
              {out.map((e) => (
                <FlowRow
                  key={e.id}
                  variant="out"
                  label={e.label}
                  onClick={selectWf(e.toWorkflow)}
                  edgeId={e.id}
                  onHoverEdge={onHoverEdge}
                >
                  <span className="tgt">
                    {wfById.get(e.toWorkflow)?.name ?? e.toWorkflow}
                  </span>
                </FlowRow>
              ))}
            </div>
          ) : (
            <div className="wfd-empty">terminal — no outgoing routes</div>
          )}
        </section>

        <section className="wfd-sec">
          <div className="wfd-lbl">
            Routes in <span className="n">{inb.length}</span>
          </div>
          {inb.length ? (
            <div className="wfd-flow">
              {inb.map((e) => (
                <FlowRow
                  key={e.id}
                  variant="in"
                  label={e.label}
                  onClick={selectWf(e.fromWorkflow)}
                  edgeId={e.id}
                  onHoverEdge={onHoverEdge}
                >
                  <span className="tgt">
                    {wfById.get(e.fromWorkflow)?.name ?? e.fromWorkflow}
                  </span>
                </FlowRow>
              ))}
            </div>
          ) : (
            <div className="wfd-empty">no inbound routes</div>
          )}
        </section>
      </div>
    </div>
  );
}

/** One clickable transition row. `children` is the endpoint content (a single
 * workflow name for routes, or step → step for loop-backs); `label` is the
 * route name chip. */
function FlowRow({
  variant,
  label,
  onClick,
  children,
  edgeId,
  onHoverEdge,
}: {
  variant: "out" | "in" | "loop";
  label: string | null;
  onClick: () => void;
  children: ReactNode;
  /** Model edge id this row represents (for the canvas cross-highlight). */
  edgeId?: string;
  onHoverEdge?: (edgeId: string | null) => void;
}) {
  return (
    <button
      className={"wfd-tr " + variant}
      onClick={onClick}
      onMouseEnter={
        onHoverEdge && edgeId ? () => onHoverEdge(edgeId) : undefined
      }
      onMouseLeave={onHoverEdge ? () => onHoverEdge(null) : undefined}
      type="button"
    >
      <span className="ldot" />
      <span className="ep">{children}</span>
      {label ? <span className="lab">{label}</span> : null}
    </button>
  );
}

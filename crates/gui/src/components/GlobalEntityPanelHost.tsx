import { useMemo } from "react";
import { usePipelineSummary } from "../hooks/usePipelineSummary";
import { useEntityPanelStore } from "../stores/entityPanelStore";
import type { EntityPanelSelection } from "../stores/entityPanelStore";
import { TaskDetailPanel } from "./TaskDetail";
import {
  buildAtlasModel,
  StepInspector,
  WorkflowInspector,
  type AtlasModel,
  type AtlasSelection,
} from "./WorkflowAtlas";
import { selectionFromWorkflowTarget } from "./WorkflowAtlas/inspector/selection";
import { CloseIcon, FloatingDetailPanel, IconButton } from "./panels";
import "./WorkflowAtlas/WorkflowAtlas.css";

function selectionFromPanelTarget(
  model: AtlasModel,
  target: Exclude<EntityPanelSelection, { type: "task" }>
): AtlasSelection | null {
  return selectionFromWorkflowTarget(model, target);
}

function setAtlasSelection(selection: AtlasSelection) {
  const store = useEntityPanelStore.getState();
  if (selection.type === "workflow") {
    store.openWorkflow(selection.workflowId);
  } else {
    store.openStep(selection.stepId, selection.workflowId);
  }
}

function EmptyAtlasPanel({
  title,
  message,
  onClose,
}: {
  title: string;
  message: string;
  onClose: () => void;
}) {
  return (
    <div className="wfd kindspine" data-no-pan>
      <div className="wfd-hd">
        <div className="wfd-hd-top">
          <span className="wfd-eyebrow">Entity Link</span>
          <span className="wfd-close">
            <IconButton onClick={onClose} ariaLabel="Close panel">
              <CloseIcon />
            </IconButton>
          </span>
        </div>
        <div className="wfd-title">{title}</div>
      </div>
      <div className="wfd-body">
        <section className="wfd-sec">
          <div
            className="wfd-placeholder"
            data-testid="global-entity-panel-status"
          >
            {message}
          </div>
        </section>
      </div>
    </div>
  );
}

function AtlasEntityPanel({
  selection,
  close,
}: {
  selection: Exclude<EntityPanelSelection, { type: "task" }>;
  close: () => void;
}) {
  const { summary, isLoading, error, refetch } = usePipelineSummary();
  const model = useMemo(
    () => (summary ? buildAtlasModel(summary) : null),
    [summary]
  );
  const atlasSelection = useMemo(
    () => (model ? selectionFromPanelTarget(model, selection) : null),
    [model, selection]
  );

  let content;
  if (isLoading) {
    content = (
      <EmptyAtlasPanel
        title="Loading"
        message="Loading workflow topology..."
        onClose={close}
      />
    );
  } else if (error) {
    content = (
      <EmptyAtlasPanel
        title="Could not load entity"
        message={error}
        onClose={close}
      />
    );
  } else if (!model || !atlasSelection) {
    content = (
      <EmptyAtlasPanel
        title="Entity not found"
        message="The linked workflow or step is not available in this project."
        onClose={close}
      />
    );
  } else if (atlasSelection.type === "workflow") {
    content = (
      <WorkflowInspector
        model={model}
        workflowId={atlasSelection.workflowId}
        onSelect={setAtlasSelection}
        onClose={close}
        onRefresh={refetch}
      />
    );
  } else {
    content = (
      <StepInspector
        model={model}
        workflowId={atlasSelection.workflowId}
        stepId={atlasSelection.stepId}
        onSelect={setAtlasSelection}
        onClose={close}
      />
    );
  }

  return (
    <FloatingDetailPanel
      panelId="global-entity-panel"
      widthStorageKey="global-entity-panel-width"
      className="workflow-atlas"
      onClose={close}
      testId="global-entity-panel"
    >
      {content}
    </FloatingDetailPanel>
  );
}

export function GlobalEntityPanelHost() {
  const selection = useEntityPanelStore((state) => state.selection);
  const close = useEntityPanelStore((state) => state.close);
  const openTask = useEntityPanelStore((state) => state.openTask);

  if (!selection) return null;

  if (selection.type === "task") {
    return (
      <TaskDetailPanel
        taskId={selection.taskId}
        onClose={close}
        onTaskSelect={openTask}
      />
    );
  }

  return <AtlasEntityPanel selection={selection} close={close} />;
}

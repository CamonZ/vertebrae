import { useState } from "react";
import {
  Background,
  BackgroundVariant,
  Controls,
  ReactFlow,
  ReactFlowProvider,
  type Edge,
  type Node,
  type NodeTypes,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import type { Step, Task, Workflow } from "../bindings";
import { DeleteConfirmation } from "../components/DeleteConfirmation";
import { FormField } from "../components/forms";
import {
  BooleanField,
  SelectField,
  TagField,
  TextareaField,
  TextField,
} from "../components/forms";
import { KanbanCard } from "../components/KanbanBoard";
import { ReadySection } from "../components/Operations";
import { RelativeTime } from "../components/RelativeTime";
import { Sidebar } from "../components/Sidebar";
import { SpineRule } from "../components/SpineRule";
import { Spinner } from "../components/Spinner";
import { LiquidHighlight } from "../components/StepDetail/LiquidHighlight";
import {
  DiagnosticId,
  IdentityBadge,
  NavigableReference,
  ScanIdentifier,
} from "../components/shared/EntityId";
import { MarkdownContent } from "../components/shared/MarkdownContent";
import { TaskLevelLabel } from "../components/shared/TaskLevelLabel";
import { Toggle } from "../components/Toggle";
import { EventGlyph } from "../components/Traces/EventGlyph";
import { ModeToggle, type TraceMode } from "../components/Traces/ModeToggle";
import { WorkflowDetailPanel } from "../components/WorkflowDetail";
import { WorkflowCard } from "../components/WorkflowGrid";
import {
  StepNode,
  type StepNodeData,
  TransitionEdgeMarkers,
  WorkflowZoneNode,
  type WorkflowZoneNodeData,
  calculateWorkflowZoneHeight,
  calculateWorkflowZoneWidth,
  transitionArrowMarker,
  transitionEdgeStyle,
} from "../components/WorkflowPipeline";
import { STYLEGUIDE_SHORTCUT } from "../utils/styleguideShortcut";
import { HearthShowcase } from "../components/HearthShowcase";
import { V2_TOKEN_GROUPS } from "../styles/hearthTokenAdapter";

const workflowPipelineNodeTypes: NodeTypes = {
  stepNode: StepNode,
  workflowZoneNode: WorkflowZoneNode,
};

function Section({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <section className="border-b border-border py-8 last:border-b-0">
      <h2 className="text-lg font-semibold text-text-primary">{title}</h2>
      <div className="mt-4">{children}</div>
    </section>
  );
}

function TokenSwatch({ name, className }: { name: string; className: string }) {
  return (
    <div className="flex items-center gap-3 rounded-lg border border-border bg-bg-secondary p-3">
      <div
        className={`h-10 w-10 rounded-md border border-border ${className}`}
      />
      <div>
        <p className="text-sm font-medium text-text-primary">{name}</p>
        <p className="font-mono text-xs text-text-muted">{className}</p>
      </div>
    </div>
  );
}

function ComponentExample({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <div className="rounded-lg border border-border bg-bg-secondary p-4">
      <h3 className="mb-3 text-xs font-semibold uppercase tracking-wider text-text-muted">
        {title}
      </h3>
      {children}
    </div>
  );
}

const sampleTask: Task = {
  id: "8f6d2a91-4c8e-4b52-9e1a-6c2f7b8d9012",
  title: "Review operator handoff flow",
  level: "ticket",
  description: "Static task sample for the GUI styleguide.",
  tags: ["gui", "review"],
  code_refs: [],
  sections: [],
  priority: null,
  archived: false,
  worktree: null,
  workflow_id: "workflow-styleguide",
  current_step_id: "step-review",
  workflow_name: "Implementation",
  step_name: "pending_review",
  rejection_reason: null,
  parent_id: null,
  dependency_ids: [],
  created_at: "2026-05-21T12:00:00Z",
  updated_at: "2026-05-22T12:00:00Z",
  started_at: null,
  completed_at: null,
  run_controls: {
    runnable: true,
    stoppable: false,
    disabled_reason: null,
    disabled_reason_code: null,
    active_run: null,
  },
};

const sampleWorkflow: Workflow = {
  id: "2f9a71c0-a8b4-4f24-9d7b-1e6c8354a210",
  name: "Implementation",
  description: "Implementation workflow for ticket delivery.",
  is_default: false,
  is_final: false,
  initial_step: "todo",
  kanban_column: "In Progress",
  created_at: null,
  updated_at: null,
};

const sampleDiagramWorkflow: Workflow = {
  ...sampleWorkflow,
  is_default: true,
  kanban_column: "In Progress",
  created_at: "2026-05-21T12:00:00Z",
  updated_at: "2026-05-22T12:00:00Z",
};

const sampleDiagramSteps: Step[] = [
  {
    id: "step-backlog",
    name: "todo",
    workflow_id: sampleDiagramWorkflow.id ?? "workflow-styleguide",
    goal: "Confirm the ticket is ready for implementation.",
    prompt: null,
    agents: [],
    skills: [],
    agent_config: {
      model: "gpt-5.3-codex",
      codex_model_provider: null,
      fallback_model: null,
      reasoning_effort: "medium",
      system_prompt: "Work from the ticket and preserve project conventions.",
      append_system_prompt: null,
      agents: null,
      tools: ["shell", "apply_patch"],
      allowed_tools: [],
      disallowed_tools: [],
      permission_mode: "accept_edits",
      max_budget_usd: null,
      mcp_config: [],
      plugin_dirs: [],
      json_schema: null,
    },
    step_type: "execute",
    output_schema: null,
    is_final: false,
    transitions_to: ["step-review"],
    order: 0,
    created_at: null,
    updated_at: null,
  },
  {
    id: "step-review",
    name: "pending_review",
    workflow_id: sampleDiagramWorkflow.id ?? "workflow-styleguide",
    goal: "Review behavior, tests, and acceptance criteria.",
    prompt: null,
    agents: [],
    skills: [],
    agent_config: {
      model: "gpt-5.3-codex",
      codex_model_provider: null,
      fallback_model: null,
      reasoning_effort: "high",
      system_prompt: "Review changed behavior before completion.",
      append_system_prompt: null,
      agents: null,
      tools: ["shell"],
      allowed_tools: [],
      disallowed_tools: [],
      permission_mode: "plan",
      max_budget_usd: null,
      mcp_config: [],
      plugin_dirs: [],
      json_schema: null,
    },
    step_type: "evaluate",
    output_schema: null,
    is_final: false,
    transitions_to: ["step-done", "step-backlog"],
    order: 1,
    created_at: null,
    updated_at: null,
  },
  {
    id: "step-done",
    name: "done",
    workflow_id: sampleDiagramWorkflow.id ?? "workflow-styleguide",
    goal: "Commit, close out, and leave the ticket complete.",
    prompt: null,
    agents: [],
    skills: [],
    agent_config: {
      model: null,
      codex_model_provider: null,
      fallback_model: null,
      reasoning_effort: null,
      system_prompt: null,
      append_system_prompt: null,
      agents: null,
      tools: [],
      allowed_tools: [],
      disallowed_tools: [],
      permission_mode: null,
      max_budget_usd: null,
      mcp_config: [],
      plugin_dirs: [],
      json_schema: null,
    },
    step_type: "route",
    output_schema: null,
    is_final: true,
    transitions_to: [],
    order: 2,
    created_at: null,
    updated_at: null,
  },
];

function MiniNavExample() {
  const navItems = ["Operations", "Board", "Design", "Tasks", "Traces"];
  return (
    <div className="flex w-16 flex-col rounded-lg border border-border bg-bg-secondary p-3">
      <ul className="space-y-1" aria-label="Styleguide navigation example">
        {navItems.map((item, index) => (
          <li key={item}>
            <div
              className={`relative flex h-10 w-10 items-center justify-center rounded-lg text-sm transition-colors ${
                index === 0
                  ? "bg-primary/10 text-primary shadow-glow-sm"
                  : "text-text-secondary"
              }`}
              title={item}
            >
              {index === 0 && (
                <span className="absolute left-0 top-1/2 h-6 w-0.5 -translate-y-1/2 rounded-full bg-primary shadow-glow-sm" />
              )}
              <span className="font-mono text-2xs">{item.slice(0, 2)}</span>
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}

function ProductFrameExample() {
  return (
    <div className="overflow-hidden rounded-lg border border-border bg-bg-primary">
      <div className="flex h-[460px] min-w-[760px]">
        <Sidebar />
        <main className="flex min-w-0 flex-1 flex-col bg-bg-primary">
          <div className="relative flex h-12 items-center justify-between border-b border-border px-5">
            <div className="neural-grid pointer-events-none absolute inset-0 opacity-20" />
            <div className="relative">
              <p className="text-sm font-semibold text-text-primary">
                Workflow Pipelines
              </p>
              <p className="font-mono text-2xs uppercase tracking-wider text-text-muted">
                App shell content header
              </p>
            </div>
            <div className="relative rounded-md border border-border bg-bg-secondary px-2 py-1 font-mono text-2xs text-text-muted">
              Side panel open
            </div>
          </div>
          <div className="flex min-h-0 flex-1">
            <div className="relative min-w-0 flex-1 overflow-hidden bg-[#0c0c0e]">
              <div className="neural-grid pointer-events-none absolute inset-0 opacity-30" />
              <div className="relative h-full p-5">
                <div className="h-full rounded-xl border border-border/70 bg-bg-secondary/20 p-4">
                  <div className="mb-4 flex items-center gap-2">
                    <span className="h-2 w-2 rounded-full bg-primary shadow-glow-sm" />
                    <span className="font-mono text-xs uppercase tracking-wider text-text-muted">
                      Diagram canvas region
                    </span>
                  </div>
                  <div className="flex gap-4">
                    <div className="h-28 w-44 rounded-lg border border-primary/40 bg-primary/10" />
                    <div className="h-28 w-44 rounded-lg border border-border bg-bg-tertiary" />
                  </div>
                </div>
              </div>
            </div>
            <WorkflowDetailPanel
              workflow={sampleDiagramWorkflow}
              steps={sampleDiagramSteps}
              taskCount={12}
            />
          </div>
        </main>
      </div>
    </div>
  );
}

function WorkflowDiagrammingExample() {
  const zoneWidth = calculateWorkflowZoneWidth(sampleDiagramSteps.length);
  const zoneHeight = calculateWorkflowZoneHeight();
  const stepNodes: Node[] = sampleDiagramSteps.map((step, index) => ({
    id: `styleguide-step-${index}`,
    type: "stepNode",
    position: {
      x: 40 + index * 320,
      y: 160,
    },
    data: {
      step,
      isFirst: index === 0,
      isLast: index === sampleDiagramSteps.length - 1,
      isSelected: index === 1,
      taskCounts: {
        epic: index === 0 ? 1 : 0,
        ticket: index === 1 ? 4 : 2,
        task: index === 2 ? 7 : 3,
      },
      executionCounts: {
        active: index === 1 ? 2 : 0,
        completed: index === 2 ? 8 : 3,
        failed: index === 1 ? 1 : 0,
      },
      isFlashing: index === 1,
    } satisfies StepNodeData,
    draggable: false,
  }));
  const nodes: Node[] = [
    {
      id: "styleguide-workflow-zone",
      type: "workflowZoneNode",
      position: { x: 0, y: 40 },
      data: {
        workflow: sampleDiagramWorkflow,
        taskCount: 12,
        stepCount: sampleDiagramSteps.length,
        width: zoneWidth,
        height: zoneHeight,
        isWorkflowSelected: true,
      } satisfies WorkflowZoneNodeData,
      draggable: false,
      selectable: false,
    },
    ...stepNodes,
  ];
  const edges: Edge[] = [
    {
      id: "styleguide-edge-forward-1",
      source: "styleguide-step-0",
      target: "styleguide-step-1",
      type: "smoothstep",
      style: transitionEdgeStyle({ selected: true }),
      markerEnd: transitionArrowMarker({ selected: true }),
    },
    {
      id: "styleguide-edge-forward-2",
      source: "styleguide-step-1",
      target: "styleguide-step-2",
      type: "smoothstep",
      style: transitionEdgeStyle({ selected: false }),
      markerEnd: transitionArrowMarker({ selected: false }),
    },
    {
      id: "styleguide-edge-return",
      source: "styleguide-step-1",
      target: "styleguide-step-0",
      type: "smoothstep",
      style: transitionEdgeStyle({ selected: false, dashed: true }),
      markerEnd: transitionArrowMarker({ selected: false }),
    },
  ];

  return (
    <div className="grid gap-4">
      <div className="h-[420px] overflow-hidden rounded-lg border border-border bg-[#0c0c0e]">
        <ReactFlowProvider>
          <TransitionEdgeMarkers />
          <ReactFlow
            nodes={nodes}
            edges={edges}
            nodeTypes={workflowPipelineNodeTypes}
            fitView
            fitViewOptions={{ padding: 0.12, minZoom: 0.35, maxZoom: 1.2 }}
            minZoom={0.2}
            maxZoom={1.4}
            nodesDraggable={false}
            nodesConnectable={false}
            elementsSelectable={false}
            colorMode="dark"
            attributionPosition="bottom-left"
            proOptions={{ hideAttribution: true }}
            style={{ backgroundColor: "#0c0c0e" }}
          >
            <Controls
              showInteractive={false}
              className="!rounded-lg !border-border !bg-bg-elevated !shadow-lg"
            />
            <Background
              variant={BackgroundVariant.Dots}
              gap={24}
              size={1}
              color="#57534e"
              bgColor="#0c0c0e"
            />
          </ReactFlow>
        </ReactFlowProvider>
      </div>
      <div className="grid gap-4 lg:grid-cols-3">
        <ComponentExample title="Workflow Container">
          <p className="text-sm text-text-secondary">
            Dashed zone, workflow metadata, task totals, and transition handles.
          </p>
        </ComponentExample>
        <ComponentExample title="Step Cards">
          <p className="text-sm text-text-secondary">
            Fixed-width nodes with order, goal, agent configuration, and state
            badges.
          </p>
        </ComponentExample>
        <ComponentExample title="Pipeline Background">
          <p className="text-sm text-text-secondary">
            React Flow controls, dotted canvas, transition arrows, and selected
            edge styling.
          </p>
        </ComponentExample>
      </div>
    </div>
  );
}

function TaskTraceExample() {
  return (
    <div className="space-y-3">
      <div className="rounded-lg border border-border bg-bg-secondary p-4">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <div className="flex flex-wrap items-center gap-2">
              <IdentityBadge
                id="8f6d2a91-4c8e-4b52-9e1a-6c2f7b8d9012"
                kind="task"
                level="ticket"
                copyable={false}
              />
              <span className="rounded-full border border-warning/40 bg-warning/10 px-2 py-0.5 text-xs font-medium text-warning">
                pending_review
              </span>
              <span className="rounded-full border border-success/40 bg-success/10 px-2 py-0.5 text-xs font-medium text-success">
                runnable
              </span>
            </div>
            <h3 className="mt-2 text-base font-semibold text-text-primary">
              Review operator handoff flow
            </h3>
            <p className="mt-1 text-sm text-text-secondary">
              Workflow step selection, route protection, and display primitives
              shown with static sample data.
            </p>
          </div>
          <button className="rounded-md bg-primary px-3 py-1.5 text-sm font-medium text-white transition-colors hover:bg-primary/90 focus:outline-none focus-visible:ring-2 focus-visible:ring-primary">
            Run
          </button>
        </div>
      </div>
      <div className="rounded-lg border border-info/40 bg-info/5 p-4">
        <div className="flex items-start gap-2">
          <svg
            className="mt-0.5 h-4 w-4 shrink-0 text-info"
            fill="none"
            stroke="currentColor"
            viewBox="0 0 24 24"
            aria-hidden="true"
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth={1.5}
              d="M12 8v4m0 4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z"
            />
          </svg>
          <div className="min-w-0">
            <p className="text-sm font-medium text-text-primary">
              Waiting on human input
            </p>
            <p className="mt-0.5 text-xs text-text-secondary">
              Step <span className="font-mono text-text-primary">review</span>{" "}
              is parked until an operator resumes it.
            </p>
            <dl className="mt-3 grid grid-cols-1 gap-2 text-eyebrow sm:grid-cols-2">
              <div>
                <dt className="font-mono uppercase tracking-wider text-text-muted">
                  Run
                </dt>
                <dd>
                  <DiagnosticId
                    id="run-019e5097aa77123"
                    kind="task run"
                    copyable={false}
                  />
                </dd>
              </div>
              <div>
                <dt className="font-mono uppercase tracking-wider text-text-muted">
                  Execution
                </dt>
                <dd>
                  <DiagnosticId
                    id="exec-019e5097bb88123"
                    kind="step execution"
                    copyable={false}
                  />
                </dd>
              </div>
            </dl>
          </div>
        </div>
      </div>
    </div>
  );
}

function FormComponentsExample() {
  const [selectValue, setSelectValue] = useState("ticket");
  const [switchValue, setSwitchValue] = useState(true);
  const [checkboxValue, setCheckboxValue] = useState(true);
  const [tags, setTags] = useState(["gui", "styleguide", "components"]);

  return (
    <div className="grid gap-4 lg:grid-cols-2">
      <TextField
        label="TextField"
        value="Review waiting gate display"
        maxLength={80}
        helpText="Single-line form input with character count."
        readOnly
      />
      <SelectField
        label="SelectField"
        value={selectValue}
        onChange={setSelectValue}
        options={[
          { label: "Epic", value: "epic", group: "Task levels" },
          { label: "Ticket", value: "ticket", group: "Task levels" },
          { label: "Task", value: "task", group: "Task levels" },
        ]}
      />
      <TextareaField
        label="TextareaField"
        value="Use this area for longer operator notes, implementation context, or review guidance."
        rows={4}
        resize="vertical"
        maxLength={180}
        readOnly
      />
      <TagField
        label="TagField"
        value={tags}
        onChange={setTags}
        maxTags={5}
        allowDuplicates={false}
      />
      <BooleanField
        label="BooleanField switch"
        value={switchValue}
        onChange={setSwitchValue}
        onText="Enabled"
        offText="Disabled"
      />
      <BooleanField
        label="BooleanField checkbox"
        value={checkboxValue}
        onChange={setCheckboxValue}
        variant="checkbox"
        onText="Human review required"
        offText="No review"
      />
    </div>
  );
}

function ControlsAndFeedbackExample() {
  const [primaryToggle, setPrimaryToggle] = useState(true);
  const [warningToggle, setWarningToggle] = useState(false);

  return (
    <div className="grid gap-4 lg:grid-cols-3">
      <ComponentExample title="Toggle">
        <div className="flex flex-wrap items-center gap-4">
          <Toggle
            checked={primaryToggle}
            onChange={setPrimaryToggle}
            label="Primary toggle"
          />
          <Toggle
            checked={warningToggle}
            onChange={setWarningToggle}
            label="Warning toggle"
            activeColor="warning"
          />
        </div>
      </ComponentExample>
      <ComponentExample title="Spinner And RelativeTime">
        <div className="flex flex-wrap items-center gap-4">
          <Spinner className="h-5 w-5 text-primary" />
          <RelativeTime date="2026-05-22T10:00:00Z" />
        </div>
      </ComponentExample>
      <ComponentExample title="SpineRule">
        <SpineRule segments={9} />
      </ComponentExample>
      <div className="lg:col-span-3">
        <DeleteConfirmation
          itemType="Task"
          itemName="Review operator handoff flow"
          isDeleting={false}
          error="Deletion is disabled in the styleguide sample."
          onConfirm={() => {}}
          onCancel={() => {}}
        >
          <label className="flex items-center gap-2 text-xs text-text-secondary">
            <input
              type="checkbox"
              readOnly
              checked
              className="accent-primary"
            />
            Include child tasks
          </label>
        </DeleteConfirmation>
      </div>
    </div>
  );
}

function SharedDisplayExample() {
  return (
    <div className="grid gap-4 lg:grid-cols-2">
      <ComponentExample title="EntityId Variants">
        <div className="flex flex-wrap items-center gap-3">
          <ScanIdentifier
            id={sampleTask.id}
            kind="task"
            level="ticket"
            copyable={false}
          />
          <IdentityBadge
            id={sampleTask.id}
            kind="task"
            level="ticket"
            copyable={false}
          />
          <NavigableReference
            id="step-019e5097aa77123"
            kind="step"
            copyable={false}
          />
          <DiagnosticId
            id="exec-019e5097bb88123"
            kind="step execution"
            copyable={false}
          />
        </div>
      </ComponentExample>
      <ComponentExample title="TaskLevelLabel">
        <div className="flex flex-wrap gap-4">
          <TaskLevelLabel level="epic" />
          <TaskLevelLabel level="ticket" />
          <TaskLevelLabel level="task" />
        </div>
      </ComponentExample>
      <div className="lg:col-span-2">
        <ComponentExample title="MarkdownContent">
          <MarkdownContent
            text={[
              "### Review Summary",
              "- Render markdown lists and headings",
              "- Preserve `inline code` styling",
              "",
              "| Field | Value |",
              "| --- | --- |",
              "| Status | pending_review |",
            ].join("\n")}
          />
        </ComponentExample>
      </div>
    </div>
  );
}

function TaskWorkflowExample() {
  return (
    <div className="grid gap-4 lg:grid-cols-2">
      <ComponentExample title="KanbanCard">
        <KanbanCard task={sampleTask} isSelected />
      </ComponentExample>
      <ComponentExample title="WorkflowCard">
        <WorkflowCard workflow={sampleWorkflow} />
      </ComponentExample>
      <div className="lg:col-span-2">
        <ComponentExample title="ReadySection">
          <ReadySection tasks={[sampleTask]} />
        </ComponentExample>
      </div>
    </div>
  );
}

function TraceAndWorkflowExample() {
  const [mode, setMode] = useState<TraceMode>("thread");

  return (
    <div className="grid gap-4 lg:grid-cols-2">
      <ComponentExample title="ModeToggle">
        <ModeToggle mode={mode} onChange={setMode} />
      </ComponentExample>
      <ComponentExample title="EventGlyph">
        <div className="flex flex-wrap items-center gap-4">
          <EventGlyph
            event={{
              kind: "session_start",
              timestamp: "2026-05-22T10:00:00Z",
              model: "gpt-5.3-codex",
              sessionId: "session-styleguide",
            }}
            size={22}
          />
          <EventGlyph
            event={{
              kind: "tool_call",
              timestamp: "2026-05-22T10:01:00Z",
              toolName: "Bash",
              toolId: "tool-1",
              displayName: "Bash",
              icon: "terminal",
              summary: "npm test",
              input: {},
            }}
            size={22}
          />
          <EventGlyph
            event={{
              kind: "tool_result",
              timestamp: "2026-05-22T10:02:00Z",
              toolUseId: "tool-2",
              isError: false,
              result: "updated",
            }}
            size={22}
          />
        </div>
      </ComponentExample>
      <div className="lg:col-span-2">
        <ComponentExample title="LiquidHighlight">
          <LiquidHighlight
            source={
              '{% if task.level == "ticket" %}\n  {{ task.title | default: "Untitled" }}\n{% endif %}'
            }
          />
        </ComponentExample>
      </div>
    </div>
  );
}

export function StyleguidePage() {
  return (
    <div className="min-h-0 flex-1 overflow-y-auto bg-bg-primary">
      <div className="mx-auto w-full max-w-6xl px-6 py-8">
        <header className="border-b border-border pb-6">
          <p className="font-mono text-xs uppercase tracking-wider text-text-muted">
            Protected route /styleguide
          </p>
          <div className="mt-2 flex flex-wrap items-end justify-between gap-4">
            <div>
              <h1 className="text-3xl font-semibold text-text-primary">
                GUI Styleguide
              </h1>
              <p className="mt-2 max-w-2xl text-sm text-text-secondary">
                Visual tokens and representative app components. Reveal the
                hidden styleguide and live chat controls with{" "}
                {STYLEGUIDE_SHORTCUT.label}.
              </p>
            </div>
            <span className="rounded-md border border-border bg-bg-secondary px-3 py-1.5 font-mono text-xs text-text-secondary">
              {STYLEGUIDE_SHORTCUT.label}
            </span>
          </div>
        </header>

        <HearthShowcase />

        <Section title="V2 Token Adapter">
          <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(280px,0.85fr)]">
            <div className="rounded-[var(--radius-md)] border border-[var(--color-line)] bg-[var(--color-bg-1)] p-4">
              <h3 className="font-mono text-2xs uppercase tracking-[0.14em] text-[var(--color-accent)]">
                Adapter decision
              </h3>
              <p className="mt-3 max-w-3xl text-sm leading-relaxed text-[var(--color-fg-soft)]">
                The production GUI keeps <code>--color-*</code>,{" "}
                <code>--spacing-*</code>, and <code>--radius-*</code> as the
                canonical Hearth token language. The docs/design v2 short names
                are available only as aliases in <code>src/index.css</code>, so
                ported React components can use the prototype vocabulary while
                still resolving through the app-owned light/dark theme.
              </p>
              <p className="mt-3 text-sm leading-relaxed text-[var(--color-fg-mute)]">
                Future Hearth work should port component structure and state,
                then either use production tokens directly or consume these
                aliases. Do not import docs/design HTML, CDN scripts, or
                prototype CSS wholesale into the app bundle.
              </p>
            </div>
            <div className="rounded-[var(--radius-md)] border border-[var(--color-line)] bg-[var(--color-bg-1)] p-4">
              <h3 className="font-mono text-2xs uppercase tracking-[0.14em] text-[var(--color-fg-mute)]">
                Inventory from components-v2.css and components-lib.css
              </h3>
              <div className="mt-3 grid gap-3">
                {V2_TOKEN_GROUPS.map((group) => (
                  <div key={group.label}>
                    <div className="font-mono text-2xs uppercase tracking-[0.12em] text-[var(--color-fg-faint)]">
                      {group.label}
                    </div>
                    <div className="mt-1 flex flex-wrap gap-1.5">
                      {group.tokens.map((token) => (
                        <code
                          key={token}
                          className="rounded-[var(--radius-xs)] border border-[var(--color-line)] bg-[var(--color-bg)] px-1.5 py-0.5 font-mono text-2xs text-[var(--color-fg-soft)]"
                        >
                          {token}
                        </code>
                      ))}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          </div>
        </Section>

        <Section title="Visual Tokens">
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <TokenSwatch name="Primary" className="bg-primary" />
            <TokenSwatch name="Accent" className="bg-accent" />
            <TokenSwatch name="Success" className="bg-success" />
            <TokenSwatch name="Warning" className="bg-warning" />
            <TokenSwatch name="Info" className="bg-info" />
            <TokenSwatch name="Error" className="bg-error" />
            <TokenSwatch name="Surface" className="bg-bg-secondary" />
            <TokenSwatch name="Hover" className="bg-bg-hover" />
          </div>
        </Section>

        <Section title="Product Frame">
          <ProductFrameExample />
        </Section>

        <Section title="Navigation">
          <MiniNavExample />
        </Section>

        <Section title="Workflow Diagramming System">
          <WorkflowDiagrammingExample />
        </Section>

        <Section title="Buttons And Forms">
          <div className="grid gap-4 lg:grid-cols-2">
            <div className="space-y-3">
              <button className="rounded-md bg-primary px-3 py-2 text-sm font-medium text-white transition-colors hover:bg-primary/90 focus:outline-none focus-visible:ring-2 focus-visible:ring-primary">
                Primary action
              </button>
              <button className="ml-2 rounded-md border border-border bg-bg-secondary px-3 py-2 text-sm font-medium text-text-primary transition-colors hover:bg-bg-hover focus:outline-none focus-visible:ring-2 focus-visible:ring-primary">
                Secondary action
              </button>
            </div>
            <div className="rounded-lg border border-border bg-bg-secondary p-4">
              <FormField
                label="Task title"
                required
                helpText="Uses the shared FormField primitive."
                inputId="styleguide-task-title"
              >
                <input
                  id="styleguide-task-title"
                  defaultValue="Review waiting gate display"
                  className="w-full rounded-md border border-border bg-bg-primary px-3 py-2 text-sm text-text-primary outline-none transition-colors focus:border-primary focus:ring-2 focus:ring-primary/20"
                />
              </FormField>
            </div>
          </div>
        </Section>

        <Section title="Form Components">
          <FormComponentsExample />
        </Section>

        <Section title="Controls And Feedback">
          <ControlsAndFeedbackExample />
        </Section>

        <Section title="Shared Display Components">
          <SharedDisplayExample />
        </Section>

        <Section title="Badges And IDs">
          <div className="flex flex-wrap items-center gap-3">
            <IdentityBadge
              id="2f9a71c0-a8b4-4f24-9d7b-1e6c8354a210"
              kind="task"
              level="epic"
              copyable={false}
            />
            <IdentityBadge
              id="8f6d2a91-4c8e-4b52-9e1a-6c2f7b8d9012"
              kind="task"
              level="ticket"
              copyable={false}
            />
            <DiagnosticId
              id="step-019e5097aa77123"
              kind="step"
              copyable={false}
            />
            <span className="rounded-full border border-primary/40 bg-primary/10 px-2 py-0.5 text-xs font-medium text-primary">
              workflow
            </span>
          </div>
        </Section>

        <Section title="Panels And Trace Displays">
          <TaskTraceExample />
        </Section>

        <Section title="Task And Workflow Components">
          <TaskWorkflowExample />
        </Section>

        <Section title="Trace And Workflow Utilities">
          <TraceAndWorkflowExample />
        </Section>
      </div>
    </div>
  );
}

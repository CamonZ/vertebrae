import type {
  JsonValue,
  PipelineStep,
  PipelineSummary,
  PipelineWorkflow,
} from "../../../bindings";

export function step(
  id: string,
  type: string | null,
  order: number
): PipelineStep {
  return {
    id,
    name: id,
    workflow_id: "a",
    goal: null,
    step_order: order,
    step_type: type,
    transitions_to: [],
    transition_sessions: {},
    task_counts: { epic: 0, ticket: 0, task: 0 },
    pipeline_counts: { epic: 0, ticket: 0, task: 0, active: 0 },
    active_count: 0,
  };
}
export function workflow(
  id: string,
  steps: PipelineStep[] = []
): PipelineWorkflow {
  return {
    id,
    name: id,
    description: null,
    initial_step_id: steps[0]?.id ?? null,
    kanban_column: null,
    factory_name: "factory",
    is_default: false,
    display_order: 0,
    workflow_steps: steps.map((s) => ({ ...s, workflow_id: id })),
    transitions: [],
  };
}
export function fixture(): {
  summary: PipelineSummary;
  configs: Map<string, JsonValue | null>;
} {
  const a = workflow("a", [
    step("llm", "llm_inference", 0),
    step("typed", "structured_inference", 1),
    step("script", "execute", 2),
    step("choose", "route", 3),
    step("approve", "human_input", 4),
    step("join", "wait_children", 5),
    step("pause", "stop", 6),
    step("done", "finish", 7),
  ]);
  a.workflow_steps[2].transitions_to = ["choose", "llm"];
  a.workflow_steps[2].transition_sessions = {
    llm: { mode: "resume", step_id: "typed" },
  };
  a.workflow_steps[3].transitions_to = ["llm", "choose", "done", "approve"];
  const b = workflow("b", [
    step("start", "execute", 0),
    step("end", "finish", 1),
  ]);
  a.transitions = [
    {
      id: "explicit",
      from_workflow_id: "a",
      to_workflow_id: "b",
      target_step_id: "end",
      label: "deliver",
    },
    {
      id: "initial",
      from_workflow_id: "a",
      to_workflow_id: "b",
      target_step_id: null,
      label: "restart",
    },
    {
      id: "empty",
      from_workflow_id: "a",
      to_workflow_id: "empty",
      target_step_id: null,
      label: "empty handoff",
    },
  ];
  const rules = [
    {
      id: "retry",
      transition: { type: "intra_workflow", step_id: "llm" },
      session: { mode: "resume", step_id: "typed" },
    },
    { id: "self", transition: { type: "intra_workflow", step_id: "choose" } },
    { id: "yes", transition: { type: "intra_workflow", step_id: "done" } },
    {
      id: "also",
      transition: { type: "intra_workflow", step_id: "done" },
      session: { mode: "fork", step_id: "llm" },
    },
    {
      id: "elsewhere",
      transition: { type: "inter_workflow", workflow_id: "empty" },
    },
  ];
  return {
    summary: {
      workflows: [
        a,
        b,
        {
          ...workflow("empty"),
          transitions: [
            {
              id: "from-empty",
              from_workflow_id: "empty",
              to_workflow_id: "b",
              target_step_id: null,
              label: "empty origin",
            },
          ],
        },
      ],
    },
    configs: new Map([
      [
        "choose",
        {
          rules,
          default: {
            transition: { type: "intra_workflow", step_id: "approve" },
          },
        },
      ],
    ]),
  };
}

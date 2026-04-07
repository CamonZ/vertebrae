import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act, waitFor } from "@testing-library/react";
import { render, screen, createMockWorkflow, createMockStep, createMockTask } from "../test/test-utils";
import { useWorkflowStore } from "../stores/workflowStore";
import { useTaskStore } from "../stores/taskStore";
import { useStepStore } from "../stores/stepStore";
import { useExecutionStore } from "../stores/executionStore";
import { AllWorkflowsPipeline } from "./AllWorkflowsPipeline";

vi.mock("../bindings", () => ({
  commands: {
    getPipelineData: vi.fn(),
    getTaskExecutions: vi.fn(),
  },
  events: {
    taskChangedEvent: {
      listen: vi.fn(() => Promise.resolve(() => {})),
    },
    workflowChangedEvent: {
      listen: vi.fn(() => Promise.resolve(() => {})),
    },
    stepChangedEvent: {
      listen: vi.fn(() => Promise.resolve(() => {})),
    },
    stepExecutionChangedEvent: {
      listen: vi.fn(() => Promise.resolve(() => {})),
    },
    sectionChangedEvent: {
      listen: vi.fn(() => Promise.resolve(() => {})),
    },
    sessionLogChangedEvent: {
      listen: vi.fn(() => Promise.resolve(() => {})),
    },
    stepTransitionChangedEvent: {
      listen: vi.fn(() => Promise.resolve(() => {})),
    },
    taskStepChangedEvent: {
      listen: vi.fn(() => Promise.resolve(() => {})),
    },
  },
}));

import { commands } from "../bindings";

const workflow1 = createMockWorkflow({ id: "wf-1", name: "Pipeline Alpha" });
const workflow2 = createMockWorkflow({ id: "wf-2", name: "Pipeline Beta" });

const stepsWf1 = [
  createMockStep({ id: "s1", name: "backlog", workflow_id: "wf-1", order: 0 }),
  createMockStep({ id: "s2", name: "in_progress", workflow_id: "wf-1", order: 1 }),
];

const stepsWf2 = [
  createMockStep({ id: "s3", name: "todo", workflow_id: "wf-2", order: 0 }),
];

const taskInWf1 = createMockTask({
  id: "t1",
  title: "Task in WF1",
  workflow_id: "wf-1",
  current_step_id: "s1",
  step_name: "backlog",
});

function resetStores() {
  useWorkflowStore.getState().setWorkflows([]);
  useTaskStore.getState().setTasks([]);
  useStepStore.getState().setSteps([]);
  useExecutionStore.getState().setExecutions([]);
}

describe("AllWorkflowsPipeline store integration", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetStores();

    vi.mocked(commands.getPipelineData).mockResolvedValue({
      status: "ok",
      data: {
        workflows: [workflow1],
        workflow_steps: { "wf-1": stepsWf1 },
        tasks: [taskInWf1],
        transitions: [],
      },
    });

    vi.mocked(commands.getTaskExecutions).mockResolvedValue({
      status: "ok",
      data: [],
    });
  });

  afterEach(() => {
    resetStores();
  });

  it("seeds the workflow store from getPipelineData", async () => {
    render(<AllWorkflowsPipeline />);

    await waitFor(() => {
      const storedWorkflows = useWorkflowStore.getState().workflows;
      expect(storedWorkflows).toHaveLength(1);
      expect(storedWorkflows[0].id).toBe("wf-1");
      expect(storedWorkflows[0].name).toBe("Pipeline Alpha");
    });
  });

  it("seeds the task store from getPipelineData", async () => {
    render(<AllWorkflowsPipeline />);

    await waitFor(() => {
      const storedTasks = useTaskStore.getState().tasks;
      expect(storedTasks).toHaveLength(1);
      expect(storedTasks[0].id).toBe("t1");
      expect(storedTasks[0].title).toBe("Task in WF1");
    });
  });

  it("seeds the step store from getPipelineData", async () => {
    render(<AllWorkflowsPipeline />);

    await waitFor(() => {
      const storedSteps = useStepStore.getState().steps;
      expect(storedSteps).toHaveLength(2);
      expect(storedSteps.map((s) => s.id)).toEqual(["s1", "s2"]);
    });
  });

  it("renders workflow name from the store after seeding", async () => {
    render(<AllWorkflowsPipeline />);

    await waitFor(() => {
      expect(screen.getByText("Pipeline Alpha")).toBeInTheDocument();
    });
  });

  it("re-renders when the workflow store is updated externally", async () => {
    render(<AllWorkflowsPipeline />);

    await waitFor(() => {
      expect(screen.getByText("Pipeline Alpha")).toBeInTheDocument();
    });

    // Simulate an external update (e.g. from GlobalListeners)
    act(() => {
      useWorkflowStore.getState().upsertWorkflow(workflow2);
    });

    await waitFor(() => {
      expect(screen.getByText("Pipeline Beta")).toBeInTheDocument();
    });

    // Original workflow still present
    expect(screen.getByText("Pipeline Alpha")).toBeInTheDocument();
  });

  it("re-renders when tasks are added to the task store externally", async () => {
    render(<AllWorkflowsPipeline />);

    await waitFor(() => {
      expect(screen.getByText("Pipeline Alpha")).toBeInTheDocument();
    });

    const newTask = createMockTask({
      id: "t2",
      title: "New External Task",
      workflow_id: "wf-1",
      current_step_id: "s2",
      step_name: "in_progress",
    });

    act(() => {
      useTaskStore.getState().upsertTask(newTask);
    });

    await waitFor(() => {
      const storedTasks = useTaskStore.getState().tasks;
      expect(storedTasks).toHaveLength(2);
      expect(storedTasks.map((t) => t.id).sort()).toEqual(["t1", "t2"]);
    });
  });

  it("re-renders when steps are added to the step store externally", async () => {
    // Seed with wf-1 and wf-2
    vi.mocked(commands.getPipelineData).mockResolvedValue({
      status: "ok",
      data: {
        workflows: [workflow1, workflow2],
        workflow_steps: { "wf-1": stepsWf1, "wf-2": stepsWf2 },
        tasks: [],
        transitions: [],
      },
    });

    render(<AllWorkflowsPipeline />);

    await waitFor(() => {
      expect(screen.getByText("Pipeline Beta")).toBeInTheDocument();
    });

    const newStep = createMockStep({
      id: "s4",
      name: "review",
      workflow_id: "wf-2",
      order: 1,
    });

    act(() => {
      useStepStore.getState().upsertStep(newStep);
    });

    await waitFor(() => {
      const storedSteps = useStepStore.getState().steps;
      expect(storedSteps.filter((s) => s.workflow_id === "wf-2")).toHaveLength(2);
    });
  });

  it("shows empty state when no workflows in the store", async () => {
    vi.mocked(commands.getPipelineData).mockResolvedValue({
      status: "ok",
      data: {
        workflows: [],
        workflow_steps: {},
        tasks: [],
        transitions: [],
      },
    });

    render(<AllWorkflowsPipeline />);

    await waitFor(() => {
      expect(screen.getByText("No workflows yet")).toBeInTheDocument();
    });
  });

  it("shows error state when getPipelineData fails", async () => {
    vi.mocked(commands.getPipelineData).mockResolvedValue({
      status: "error",
      error: { message: "Connection refused" },
    });

    render(<AllWorkflowsPipeline />);

    await waitFor(() => {
      expect(screen.getByText("Error Loading Workflows")).toBeInTheDocument();
      expect(screen.getByText("Connection refused")).toBeInTheDocument();
    });
  });

  it("displays correct workflow count in header", async () => {
    vi.mocked(commands.getPipelineData).mockResolvedValue({
      status: "ok",
      data: {
        workflows: [workflow1, workflow2],
        workflow_steps: { "wf-1": stepsWf1, "wf-2": stepsWf2 },
        tasks: [],
        transitions: [],
      },
    });

    render(<AllWorkflowsPipeline />);

    await waitFor(() => {
      expect(screen.getByText("2 workflows visualized")).toBeInTheDocument();
    });
  });

  it("correctly derives task count per workflow for zone display", async () => {
    const tasks = [
      createMockTask({ id: "ta", title: "A", workflow_id: "wf-1" }),
      createMockTask({ id: "tb", title: "B", workflow_id: "wf-1" }),
      createMockTask({ id: "tc", title: "C", workflow_id: "wf-2" }),
    ];

    vi.mocked(commands.getPipelineData).mockResolvedValue({
      status: "ok",
      data: {
        workflows: [workflow1, workflow2],
        workflow_steps: { "wf-1": stepsWf1, "wf-2": stepsWf2 },
        tasks,
        transitions: [],
      },
    });

    render(<AllWorkflowsPipeline />);

    await waitFor(() => {
      expect(screen.getByText("Pipeline Alpha")).toBeInTheDocument();
      expect(screen.getByText("Pipeline Beta")).toBeInTheDocument();
    });

    // Verify the task store was seeded correctly
    const storedTasks = useTaskStore.getState().tasks;
    expect(storedTasks).toHaveLength(3);

    const wf1Tasks = storedTasks.filter((t) => t.workflow_id === "wf-1");
    const wf2Tasks = storedTasks.filter((t) => t.workflow_id === "wf-2");
    expect(wf1Tasks).toHaveLength(2);
    expect(wf2Tasks).toHaveLength(1);
  });
});

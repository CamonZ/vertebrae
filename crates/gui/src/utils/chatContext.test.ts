import { describe, it, expect, vi, beforeEach } from "vitest";
import { buildInitialPrompt, scopeLabel } from "./chatContext";
import { commands } from "../bindings";

// Mock bindings for buildContextSummary
vi.mock("../bindings", () => ({
  commands: {
    getCurrentProject: vi.fn().mockResolvedValue({
      status: "ok",
      data: "test-project",
    }),
    getCurrentProjectPath: vi.fn().mockResolvedValue({
      status: "ok",
      data: "/home/user/project",
    }),
    getTask: vi.fn().mockResolvedValue({
      status: "ok",
      data: {
        id: "task-123",
        title: "Test Task",
        description: "A test task",
        workflow_name: "Implementation",
        step_name: "in_progress",
        level: "task",
        sections: [
          {
            type: "checklist_item",
            content: "Do thing A",
            done: false,
          },
          {
            type: "constraint",
            content: "Must be fast",
            done: false,
          },
        ],
        code_refs: [
          { path: "src/main.rs", line_start: 42, name: "main" },
        ],
      },
    }),
    getTaskExecutions: vi.fn().mockResolvedValue({
      status: "ok",
      data: [
        {
          step_name: "review",
          status: "completed",
          started_at: "2024-01-01T00:00:00Z",
        },
      ],
    }),
    getWorkflowWithTasks: vi.fn().mockResolvedValue({
      status: "ok",
      data: {
        workflow: {
          name: "Deploy Pipeline",
          description: "Deploys the app",
        },
        tasks: [
          {
            id: "aabbccdd-1111-2222-3333-444455556666",
            title: "Build",
            workflow_name: "Implementation",
            step_name: "done",
          },
          {
            id: "eeff0011-2233-4455-6677-8899aabbccdd",
            title: "Test",
            workflow_name: "Implementation",
            step_name: "in_progress",
          },
        ],
      },
    }),
    getStep: vi.fn().mockResolvedValue({
      status: "ok",
      data: {
        id: "step-1",
        name: "Review Step",
        prompt: "Review the code for {{task}}",
        eval_prompt: null,
        agent_config: { model: "claude-sonnet-4" },
      },
    }),
  },
}));

const mockedCommands = vi.mocked(commands);

describe("buildInitialPrompt", () => {
  it("returns just the user message when no context", () => {
    const result = buildInitialPrompt(null, "Hello Claude");
    expect(result).toBe("Hello Claude");
  });

  it("prepends context summary with separator", () => {
    const context = "[Context: Task]\nTask: My Task";
    const result = buildInitialPrompt(context, "What should I do next?");

    expect(result).toBe(
      "[Context: Task]\nTask: My Task\n\n---\n\nWhat should I do next?"
    );
  });

  it("preserves multiline context", () => {
    const context = "[Context: Task]\nTitle: Test\nStatus: open\nSections:\n  - Check A";
    const result = buildInitialPrompt(context, "Help");

    expect(result).toContain("[Context: Task]");
    expect(result).toContain("Sections:");
    expect(result).toContain("---");
    expect(result).toContain("Help");
  });
});

describe("scopeLabel", () => {
  it("returns Project for project scope", () => {
    expect(scopeLabel("project")).toBe("Project");
  });

  it("returns Workflow for workflow scope", () => {
    expect(scopeLabel("workflow")).toBe("Workflow");
  });

  it("returns Task for task scope", () => {
    expect(scopeLabel("task")).toBe("Task");
  });

  it("returns Step for step scope", () => {
    expect(scopeLabel("step")).toBe("Step");
  });
});

describe("buildContextSummary", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("builds project context with project name and path", async () => {
    // Need to import after mocks are set up
    const { buildContextSummary } = await import("./chatContext");
    const result = await buildContextSummary("project", null);

    expect(result).toContain("[Context: Project]");
    expect(result).toContain("Project: test-project");
    expect(result).toContain("Path: /home/user/project");
  });

  it("builds task context with title, status, sections, and code refs", async () => {
    const { buildContextSummary } = await import("./chatContext");
    const result = await buildContextSummary("task", "task-123");

    expect(result).toContain("[Context: Task]");
    expect(result).toContain("Task: Test Task");
    expect(result).toContain("Status: Implementation:in_progress");
    expect(result).toContain("Description: A test task");
    expect(result).toContain("checklist_item: Do thing A [pending]");
    expect(result).toContain("constraint: Must be fast");
    expect(result).toContain("src/main.rs:L42 (main)");
    expect(result).toContain('Execution history: 1 execution(s)');
    expect(result).toContain('Step "review" (completed)');
  });

  it("builds workflow context with name, description, and tasks", async () => {
    const { buildContextSummary } = await import("./chatContext");
    const result = await buildContextSummary("workflow", "wf-1");

    expect(result).toContain("[Context: Workflow]");
    expect(result).toContain("Workflow: Deploy Pipeline");
    expect(result).toContain("Description: Deploys the app");
    expect(result).toContain("Tasks assigned: 2");
    expect(result).toContain("Build (Implementation:done)");
    expect(result).toContain("Test (Implementation:in_progress)");
  });

  it("builds step context with name and prompt template", async () => {
    const { buildContextSummary } = await import("./chatContext");
    const result = await buildContextSummary("step", "step-1");

    expect(result).toContain("[Context: Step]");
    expect(result).toContain("Step: Review Step");
    expect(result).toContain("Prompt: Review the code for {{task}}");
    expect(result).toContain("Agent: model=claude-sonnet-4");
  });

  it("returns null for unknown scope with null entityId", async () => {
    const { buildContextSummary } = await import("./chatContext");
    const result = await buildContextSummary("workflow", null);

    expect(result).toBeNull();
  });

  it("returns null for task scope with null entityId", async () => {
    const { buildContextSummary } = await import("./chatContext");
    const result = await buildContextSummary("task", null);

    expect(result).toBeNull();
  });

  it("returns null for step scope with null entityId", async () => {
    const { buildContextSummary } = await import("./chatContext");
    const result = await buildContextSummary("step", null);

    expect(result).toBeNull();
  });

  // --- Workflow context edge cases ---

  it("workflow context omits description when absent", async () => {
    mockedCommands.getWorkflowWithTasks.mockResolvedValueOnce({
      status: "ok",
      data: {
        workflow: { name: "Simple WF", description: null },
        tasks: [],
      },
    } as never);

    const { buildContextSummary } = await import("./chatContext");
    const result = await buildContextSummary("workflow", "wf-2");

    expect(result).toContain("Workflow: Simple WF");
    expect(result).not.toContain("Description:");
    expect(result).toContain("Tasks assigned: 0");
  });

  it("workflow context does not show task list when empty", async () => {
    mockedCommands.getWorkflowWithTasks.mockResolvedValueOnce({
      status: "ok",
      data: {
        workflow: { name: "Empty WF", description: null },
        tasks: [],
      },
    } as never);

    const { buildContextSummary } = await import("./chatContext");
    const result = await buildContextSummary("workflow", "wf-empty");

    expect(result).not.toContain("Assigned tasks:");
  });

  it("workflow context truncates at 10 tasks and shows remainder", async () => {
    const tasks = Array.from({ length: 15 }, (_, i) => ({
      id: `${"abcdef01-2345-6789-0123-456789abcdef".slice(0, -2)}${String(i).padStart(2, "0")}`,
      title: `Task ${i}`,
      workflow_name: "WF",
      step_name: "todo",
    }));

    mockedCommands.getWorkflowWithTasks.mockResolvedValueOnce({
      status: "ok",
      data: {
        workflow: { name: "Big WF", description: null },
        tasks,
      },
    } as never);

    const { buildContextSummary } = await import("./chatContext");
    const result = await buildContextSummary("workflow", "wf-big");

    expect(result).toContain("Tasks assigned: 15");
    expect(result).toContain("Task 0");
    expect(result).toContain("Task 9");
    expect(result).not.toContain("Task 10");
    expect(result).toContain("... and 5 more");
  });

  it("workflow context returns null when API fails", async () => {
    mockedCommands.getWorkflowWithTasks.mockResolvedValueOnce({
      status: "error",
      error: "not found",
    } as never);

    const { buildContextSummary } = await import("./chatContext");
    const result = await buildContextSummary("workflow", "wf-bad");

    expect(result).toBeNull();
  });

  it("workflow context shows 'unknown' status when workflow_name and step_name are absent", async () => {
    mockedCommands.getWorkflowWithTasks.mockResolvedValueOnce({
      status: "ok",
      data: {
        workflow: { name: "WF", description: null },
        tasks: [
          {
            id: "aabbccdd-1111-2222-3333-444455556666",
            title: "Unassigned",
            workflow_name: null,
            step_name: null,
          },
        ],
      },
    } as never);

    const { buildContextSummary } = await import("./chatContext");
    const result = await buildContextSummary("workflow", "wf-3");

    expect(result).toContain("(unknown)");
  });

  // --- Task context edge cases ---

  it("task context omits description when absent", async () => {
    mockedCommands.getTask.mockResolvedValueOnce({
      status: "ok",
      data: {
        id: "task-no-desc",
        title: "No Desc Task",
        description: null,
        workflow_name: null,
        step_name: null,
        level: "task",
        sections: [],
        code_refs: [],
      },
    } as never);
    mockedCommands.getTaskExecutions.mockResolvedValueOnce({
      status: "ok",
      data: [],
    } as never);

    const { buildContextSummary } = await import("./chatContext");
    const result = await buildContextSummary("task", "task-no-desc");

    expect(result).toContain("Task: No Desc Task");
    expect(result).not.toContain("Description:");
    expect(result).toContain("Status: unknown");
    expect(result).not.toContain("Sections:");
    expect(result).not.toContain("Code references:");
    expect(result).not.toContain("Execution history:");
  });

  it("task context shows checklist done marker", async () => {
    mockedCommands.getTask.mockResolvedValueOnce({
      status: "ok",
      data: {
        id: "task-done",
        title: "Done Items",
        description: null,
        workflow_name: "WF",
        step_name: "done",
        level: "task",
        sections: [
          { type: "checklist_item", content: "Completed item", done: true },
        ],
        code_refs: [],
      },
    } as never);
    mockedCommands.getTaskExecutions.mockResolvedValueOnce({
      status: "ok",
      data: [],
    } as never);

    const { buildContextSummary } = await import("./chatContext");
    const result = await buildContextSummary("task", "task-done");

    expect(result).toContain("checklist_item: Completed item [done]");
  });

  it("task context formats code ref without line_start or name", async () => {
    mockedCommands.getTask.mockResolvedValueOnce({
      status: "ok",
      data: {
        id: "task-ref",
        title: "Ref Task",
        description: null,
        workflow_name: null,
        step_name: null,
        level: "task",
        sections: [],
        code_refs: [
          { path: "src/lib.rs", line_start: null, name: null },
        ],
      },
    } as never);
    mockedCommands.getTaskExecutions.mockResolvedValueOnce({
      status: "ok",
      data: [],
    } as never);

    const { buildContextSummary } = await import("./chatContext");
    const result = await buildContextSummary("task", "task-ref");

    expect(result).toContain("Code references:");
    expect(result).toContain("  - src/lib.rs");
    expect(result).not.toContain(":L");
    // Should not have trailing parenthesized name
    expect(result).not.toMatch(/src\/lib\.rs\s*\(/);
  });

  it("task context shows 'unknown' for null started_at in execution", async () => {
    mockedCommands.getTask.mockResolvedValueOnce({
      status: "ok",
      data: {
        id: "task-exec",
        title: "Exec Task",
        description: null,
        workflow_name: null,
        step_name: null,
        level: "task",
        sections: [],
        code_refs: [],
      },
    } as never);
    mockedCommands.getTaskExecutions.mockResolvedValueOnce({
      status: "ok",
      data: [
        { step_name: "build", status: "running", started_at: null },
      ],
    } as never);

    const { buildContextSummary } = await import("./chatContext");
    const result = await buildContextSummary("task", "task-exec");

    expect(result).toContain('Step "build" (running) at unknown');
  });

  it("task context returns null when API fails", async () => {
    mockedCommands.getTask.mockResolvedValueOnce({
      status: "error",
      error: "not found",
    } as never);
    mockedCommands.getTaskExecutions.mockResolvedValueOnce({
      status: "ok",
      data: [],
    } as never);

    const { buildContextSummary } = await import("./chatContext");
    const result = await buildContextSummary("task", "task-bad");

    expect(result).toBeNull();
  });

  // --- Step context edge cases ---

  it("step context omits prompt and eval_prompt when absent", async () => {
    mockedCommands.getStep.mockResolvedValueOnce({
      status: "ok",
      data: {
        id: "step-bare",
        name: "Bare Step",
        prompt: null,
        eval_prompt: null,
        agent_config: null,
      },
    } as never);

    const { buildContextSummary } = await import("./chatContext");
    const result = await buildContextSummary("step", "step-bare");

    expect(result).toContain("Step: Bare Step");
    expect(result).not.toContain("Prompt:");
    expect(result).not.toContain("Eval prompt:");
    expect(result).not.toContain("Agent:");
  });

  it("step context includes eval_prompt when present", async () => {
    mockedCommands.getStep.mockResolvedValueOnce({
      status: "ok",
      data: {
        id: "step-eval",
        name: "Eval Step",
        prompt: "Do the thing",
        eval_prompt: "Check the thing",
        agent_config: null,
      },
    } as never);

    const { buildContextSummary } = await import("./chatContext");
    const result = await buildContextSummary("step", "step-eval");

    expect(result).toContain("Prompt: Do the thing");
    expect(result).toContain("Eval prompt: Check the thing");
  });

  it("step context shows default model when agent_config.model is null", async () => {
    mockedCommands.getStep.mockResolvedValueOnce({
      status: "ok",
      data: {
        id: "step-def",
        name: "Default Model Step",
        prompt: null,
        eval_prompt: null,
        agent_config: { model: null },
      },
    } as never);

    const { buildContextSummary } = await import("./chatContext");
    const result = await buildContextSummary("step", "step-def");

    expect(result).toContain("Agent: model=default");
  });

  it("step context returns null when API fails", async () => {
    mockedCommands.getStep.mockResolvedValueOnce({
      status: "error",
      error: "not found",
    } as never);

    const { buildContextSummary } = await import("./chatContext");
    const result = await buildContextSummary("step", "step-bad");

    expect(result).toBeNull();
  });
});

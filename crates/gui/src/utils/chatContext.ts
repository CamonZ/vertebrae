/**
 * Context injection utilities for scoped chat sessions.
 *
 * Fetches read-only context from existing Tauri commands and
 * formats it as a context summary string for Claude.
 */

import { commands } from "../bindings";
import type { ChatScope } from "../stores/chatStore";

/**
 * Build a context summary string for a chat session based on scope.
 * Returns null if context cannot be loaded.
 */
export async function buildContextSummary(
  scope: ChatScope,
  entityId: string | null
): Promise<string | null> {
  switch (scope) {
    case "project":
      return buildProjectContext();
    case "workflow":
      return entityId ? buildWorkflowContext(entityId) : null;
    case "task":
      return entityId ? buildTaskContext(entityId) : null;
    case "step":
      return entityId ? buildStepContext(entityId) : null;
    default:
      return null;
  }
}

async function buildProjectContext(): Promise<string | null> {
  const parts: string[] = ["[Context: Project]"];

  const projectResult = await commands.getCurrentProject();
  if (projectResult.status === "ok" && projectResult.data) {
    parts.push(`Project: ${projectResult.data}`);
  }

  const pathResult = await commands.getCurrentProjectPath();
  if (pathResult.status === "ok" && pathResult.data) {
    parts.push(`Path: ${pathResult.data}`);
  }

  return parts.join("\n");
}

async function buildWorkflowContext(
  workflowId: string
): Promise<string | null> {
  const parts: string[] = ["[Context: Workflow]"];

  const result = await commands.getWorkflowWithTasks(workflowId);
  if (result.status === "ok" && result.data) {
    const wf = result.data;
    parts.push(`Workflow: ${wf.workflow.name}`);
    if (wf.workflow.description) {
      parts.push(`Description: ${wf.workflow.description}`);
    }
    parts.push(`Tasks assigned: ${wf.tasks.length}`);
    if (wf.tasks.length > 0) {
      parts.push("Assigned tasks:");
      for (const task of wf.tasks.slice(0, 10)) {
        const taskStatus = [task.workflow_name, task.step_name].filter(Boolean).join(":") || "unknown";
        parts.push(`  - [${task.id.substring(0, 8)}] ${task.title} (${taskStatus})`);
      }
      if (wf.tasks.length > 10) {
        parts.push(`  ... and ${wf.tasks.length - 10} more`);
      }
    }
  }

  return parts.length > 1 ? parts.join("\n") : null;
}

async function buildTaskContext(taskId: string): Promise<string | null> {
  const parts: string[] = ["[Context: Task]"];

  const result = await commands.getTask(taskId);
  if (result.status === "ok" && result.data) {
    const task = result.data;
    parts.push(`Task: ${task.title}`);
    parts.push(`ID: ${task.id}`);
    const status = [task.workflow_name, task.step_name].filter(Boolean).join(":") || "unknown";
    parts.push(`Status: ${status}`);
    parts.push(`Level: ${task.level}`);
    if (task.description) {
      parts.push(`Description: ${task.description}`);
    }

    // Sections
    if (task.sections && task.sections.length > 0) {
      parts.push("\nSections:");
      for (const section of task.sections) {
        const doneMarker =
          section.type === "checklist_item"
            ? section.done
              ? " [done]"
              : " [pending]"
            : "";
        parts.push(`  - ${section.type}: ${section.content}${doneMarker}`);
      }
    }

    // Code refs
    if (task.code_refs && task.code_refs.length > 0) {
      parts.push("\nCode references:");
      for (const ref of task.code_refs) {
        const line = ref.line_start ? `:L${ref.line_start}` : "";
        parts.push(`  - ${ref.path}${line}${ref.name ? ` (${ref.name})` : ""}`);
      }
    }
  }

  // Execution history
  const execResult = await commands.getTaskExecutions(taskId);
  if (execResult.status === "ok" && execResult.data && execResult.data.length > 0) {
    parts.push(`\nExecution history: ${execResult.data.length} execution(s)`);
    for (const exec of execResult.data.slice(0, 5)) {
      parts.push(
        `  - Step "${exec.step_name}" (${exec.status}) at ${exec.started_at ?? "unknown"}`
      );
    }
  }

  return parts.length > 1 ? parts.join("\n") : null;
}

async function buildStepContext(stepId: string): Promise<string | null> {
  const parts: string[] = ["[Context: Step]"];

  const result = await commands.getStep(stepId);
  if (result.status === "ok" && result.data) {
    const step = result.data;
    parts.push(`Step: ${step.name}`);
    parts.push(`ID: ${step.id}`);
    if (step.prompt) {
      parts.push(`Prompt: ${step.prompt}`);
    }
    if (step.agent_config) {
      parts.push(`Agent: model=${step.agent_config.model ?? "default"}`);
    }
  }

  return parts.length > 1 ? parts.join("\n") : null;
}

/**
 * Build the initial prompt that includes context injection.
 * Wraps the user's message with the context summary as a system-level preamble.
 */
export function buildInitialPrompt(
  contextSummary: string | null,
  userMessage: string
): string {
  if (!contextSummary) {
    return userMessage;
  }

  return `${contextSummary}\n\n---\n\n${userMessage}`;
}

/**
 * Get a scope label for display in breadcrumbs.
 */
export function scopeLabel(scope: ChatScope): string {
  switch (scope) {
    case "project":
      return "Project";
    case "workflow":
      return "Workflow";
    case "task":
      return "Task";
    case "step":
      return "Step";
  }
}

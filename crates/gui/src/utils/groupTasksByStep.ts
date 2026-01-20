import type { Step, TaskWithRelations } from "../bindings";

/**
 * Groups tasks by their workflow step based on current_step_id.
 * Tasks are matched to steps by checking if current_step_id ends with the step name.
 * This handles step IDs like "default_in_progress" matching step name "in_progress".
 * Tasks that don't match any step fall back to the first step.
 */
export function groupTasksByStep(
  tasks: TaskWithRelations[],
  steps: Step[]
): Map<string, TaskWithRelations[]> {
  const sortedSteps = [...steps].sort((a, b) => a.order - b.order);
  const groups = new Map<string, TaskWithRelations[]>();

  // Initialize groups for each step (keyed by step name for display compatibility)
  sortedSteps.forEach((step) => {
    groups.set(step.name.toLowerCase(), []);
  });

  // Build array of step names sorted by length (longest first) to match most specific first
  const stepNames = sortedSteps
    .map((s) => s.name.toLowerCase())
    .sort((a, b) => b.length - a.length);

  tasks.forEach((tr) => {
    const currentStepId = tr.task.current_step_id?.toLowerCase();
    if (currentStepId) {
      // Find the step name that matches as a suffix (e.g., "default_in_progress" ends with "_in_progress")
      for (const stepName of stepNames) {
        if (
          currentStepId.endsWith(`_${stepName}`) ||
          currentStepId === stepName
        ) {
          groups.get(stepName)?.push(tr);
          return;
        }
      }
    }

    // Fall back to first step if no match
    const firstStep = sortedSteps[0]?.name?.toLowerCase();
    if (firstStep && groups.has(firstStep)) {
      groups.get(firstStep)!.push(tr);
    }
  });

  return groups;
}

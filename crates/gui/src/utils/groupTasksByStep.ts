import type { Step, TaskWithRelations } from "../bindings";

/**
 * Groups tasks by their workflow step based on current_step_id.
 * Tasks are matched to steps by building a map from step ID to step name.
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

  // Build map from step ID to step name for direct lookup
  const stepIdToName = new Map<string, string>();
  sortedSteps.forEach((step) => {
    if (step.id) {
      stepIdToName.set(step.id.toLowerCase(), step.name.toLowerCase());
    }
  });

  tasks.forEach((tr) => {
    const currentStepId = tr.task.current_step_id?.toLowerCase();
    if (currentStepId) {
      // First try direct lookup by step ID
      const stepName = stepIdToName.get(currentStepId);
      if (stepName && groups.has(stepName)) {
        groups.get(stepName)?.push(tr);
        return;
      }

      // Fallback: try suffix matching for legacy step IDs (e.g., "default_in_progress")
      const stepNames = sortedSteps
        .map((s) => s.name.toLowerCase())
        .sort((a, b) => b.length - a.length);
      for (const name of stepNames) {
        if (
          currentStepId.endsWith(`_${name}`) ||
          currentStepId === name
        ) {
          groups.get(name)?.push(tr);
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

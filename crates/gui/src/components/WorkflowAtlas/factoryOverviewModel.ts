import type { PipelineSummary } from "../../bindings";
import { factoryNames } from "../../utils/workflowFactory";

export interface FactoryOverviewGroup {
  name: string;
  workflowCount: number;
  workItemCount: number;
  activeCount: number;
}

/** Aggregate only the named factories; the overview intentionally hides workflow internals. */
export function buildFactoryOverviewGroups(
  summary: PipelineSummary
): FactoryOverviewGroup[] {
  const grouped = new Map<string, FactoryOverviewGroup>();

  for (const name of factoryNames(summary.workflows)) {
    grouped.set(name, {
      name,
      workflowCount: 0,
      workItemCount: 0,
      activeCount: 0,
    });
  }

  for (const workflow of summary.workflows) {
    if (!workflow.factory_name) continue;
    const group = grouped.get(workflow.factory_name);
    if (!group) continue;
    group.workflowCount += 1;
    for (const step of workflow.workflow_steps) {
      group.workItemCount +=
        step.pipeline_counts.epic +
        step.pipeline_counts.ticket +
        step.pipeline_counts.task;
      group.activeCount += step.pipeline_counts.active;
    }
  }

  return [...grouped.values()];
}

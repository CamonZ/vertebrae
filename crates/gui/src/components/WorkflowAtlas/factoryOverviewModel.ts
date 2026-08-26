import type { PipelineSummary } from "../../bindings";
import {
  factoryNames,
  NO_FACTORY_SCOPE,
  type FactoryFilterValue,
} from "../../utils/workflowFactory";

export interface FactoryOverviewGroup {
  name: string;
  scope: FactoryFilterValue;
  workflowCount: number;
  workItemCount: number;
  activeCount: number;
}

/** Aggregate factories while keeping null factory names in a distinct synthetic group. */
export function buildFactoryOverviewGroups(
  summary: PipelineSummary
): FactoryOverviewGroup[] {
  const grouped = new Map<string, FactoryOverviewGroup>();

  for (const name of factoryNames(summary.workflows)) {
    grouped.set(name, {
      name,
      scope: name,
      workflowCount: 0,
      workItemCount: 0,
      activeCount: 0,
    });
  }

  const noFactoryGroup = summary.workflows.some(
    (workflow) => workflow.factory_name === null
  )
    ? {
        name: "No Factory",
        scope: NO_FACTORY_SCOPE,
        workflowCount: 0,
        workItemCount: 0,
        activeCount: 0,
      }
    : null;

  for (const workflow of summary.workflows) {
    const group =
      workflow.factory_name === null
        ? noFactoryGroup
        : grouped.get(workflow.factory_name);
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

  return noFactoryGroup
    ? [...grouped.values(), noFactoryGroup]
    : [...grouped.values()];
}

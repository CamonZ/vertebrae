import type { PipelineSummary } from "../../bindings";
import {
  factoryNames,
  NO_FACTORY_SCOPE,
  type FactoryFilterValue,
} from "../../utils/workflowFactory";
import { rayBox } from "./layout/geometry";
import type { AtlasModel, AtlasWorkflow, Point, Rect } from "./layout/types";

const COLLAPSED_FACTORY_W = 280;
const COLLAPSED_FACTORY_H = 150;
const CARD_W = 264;
const CARD_H = 140;
const CARD_GAP = 18;
const FACTORY_PAD_X = 22;
const FACTORY_PAD_TOP = 54;
const FACTORY_PAD_BOTTOM = 22;
const FACTORY_GAP_X = 60;
const FACTORY_GAP_Y = 48;
const OVERVIEW_PAD_X = 32;
const OVERVIEW_PAD_Y = 24;
const MAX_FACTORY_COLUMNS = 2;
const MAX_WORKFLOW_COLUMNS = 2;

/** Stable key used to group the explicit `null` factory value. */
export const NO_FACTORY_KEY = "__no_factory__";

export interface FactoryOverviewGroup {
  name: string;
  scope: FactoryFilterValue;
  /** Model workflow ids belonging to this exact factory scope. */
  workflowIds: string[];
  workflowCount: number;
  workItemCount: number;
  activeCount: number;
}

export interface FactoryOverviewWorkflow {
  workflow: AtlasWorkflow;
  /** Position relative to the containing factory node. */
  rect: Rect;
  shape: AtlasModel["steps"][number]["kind"][];
}

export interface FactoryOverviewNode extends FactoryOverviewGroup {
  rect: Rect;
  workflows: FactoryOverviewWorkflow[];
}

/** One visible workflow-to-workflow route inside an expanded factory. */
export interface FactoryOverviewWorkflowRoute {
  id: string;
  from: string;
  to: string;
  points: Point[];
}

/** One visible route between factories, regardless of how many workflows cause it. */
export interface FactoryOverviewFactoryRoute {
  id: string;
  from: string;
  to: string;
  count: number;
  points: Point[];
}

export interface FactoryOverviewLayout {
  width: number;
  height: number;
  factories: FactoryOverviewNode[];
  workflowRoutes: FactoryOverviewWorkflowRoute[];
  factoryRoutes: FactoryOverviewFactoryRoute[];
}

function factoryKey(factoryName: string | null): string {
  return factoryName === null ? NO_FACTORY_KEY : factoryName;
}

function routePoints(from: Rect, to: Rect): Point[] {
  const fromCenter = { x: from.x + from.w / 2, y: from.y + from.h / 2 };
  const toCenter = { x: to.x + to.w / 2, y: to.y + to.h / 2 };
  return [
    rayBox(fromCenter.x, fromCenter.y, toCenter.x, toCenter.y, from),
    rayBox(toCenter.x, toCenter.y, fromCenter.x, fromCenter.y, to),
  ];
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
      workflowIds: [],
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
        workflowIds: [],
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
    group.workflowIds.push(workflow.id);
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

/**
 * Lay out the unscoped factory surface as opaque nodes. Cross-factory
 * transitions are reduced to one route per factory pair, regardless of how
 * many workflow transitions produce that handoff.
 */
export function layoutFactoryOverview(
  model: AtlasModel,
  groups: FactoryOverviewGroup[],
  expanded = false
): FactoryOverviewLayout {
  const factoryColumns = Math.min(
    MAX_FACTORY_COLUMNS,
    Math.max(1, groups.length)
  );
  const groupRows: FactoryOverviewGroup[][] = [];
  for (let i = 0; i < groups.length; i += factoryColumns) {
    groupRows.push(groups.slice(i, i + factoryColumns));
  }

  const factoryWidth = expanded
    ? FACTORY_PAD_X * 2 +
      MAX_WORKFLOW_COLUMNS * CARD_W +
      (MAX_WORKFLOW_COLUMNS - 1) * CARD_GAP
    : COLLAPSED_FACTORY_W;
  const factoryHeight = (group: FactoryOverviewGroup): number => {
    if (!expanded) return COLLAPSED_FACTORY_H;
    const rows = Math.max(
      1,
      Math.ceil(group.workflowIds.length / MAX_WORKFLOW_COLUMNS)
    );
    return (
      FACTORY_PAD_TOP +
      rows * CARD_H +
      (rows - 1) * CARD_GAP +
      FACTORY_PAD_BOTTOM
    );
  };
  const rowHeights = groupRows.map((row) =>
    Math.max(...row.map((group) => factoryHeight(group)))
  );
  const yByRow: number[] = [];
  rowHeights.reduce((y, height, index) => {
    yByRow[index] = y;
    return y + height + FACTORY_GAP_Y;
  }, OVERVIEW_PAD_Y);

  const factories: FactoryOverviewNode[] = [];
  const factoryRects = new Map<string, Rect>();
  const modelWorkflows = new Map(model.workflows.map((w) => [w.id, w]));
  const modelSteps = new Map<string, AtlasModel["steps"]>();
  for (const step of model.steps) {
    const list = modelSteps.get(step.workflowId);
    if (list) list.push(step);
    else modelSteps.set(step.workflowId, [step]);
  }

  groups.forEach((group, index) => {
    const row = Math.floor(index / factoryColumns);
    const col = index % factoryColumns;
    const rect: Rect = {
      x: OVERVIEW_PAD_X + col * (factoryWidth + FACTORY_GAP_X),
      y: yByRow[row],
      w: factoryWidth,
      h: factoryHeight(group),
    };
    const key = typeof group.scope === "string" ? group.scope : NO_FACTORY_KEY;
    factoryRects.set(key, rect);
    const workflows = expanded
      ? group.workflowIds
          .map((id, workflowIndex) => {
            const workflow = modelWorkflows.get(id);
            if (!workflow) return null;
            const cardCol = workflowIndex % MAX_WORKFLOW_COLUMNS;
            const cardRow = Math.floor(workflowIndex / MAX_WORKFLOW_COLUMNS);
            return {
              workflow,
              rect: {
                x: FACTORY_PAD_X + cardCol * (CARD_W + CARD_GAP),
                y: FACTORY_PAD_TOP + cardRow * (CARD_H + CARD_GAP),
                w: CARD_W,
                h: CARD_H,
              },
              shape: workflow.stepIds
                .map((stepId) =>
                  modelSteps
                    .get(workflow.id)
                    ?.find((step) => step.stepId === stepId)
                )
                .filter((step): step is NonNullable<typeof step> => !!step)
                .map((step) => step.kind),
            } satisfies FactoryOverviewWorkflow;
          })
          .filter((workflow): workflow is FactoryOverviewWorkflow => !!workflow)
      : [];
    factories.push({ ...group, rect, workflows });
  });

  const workflowRects = new Map<string, Rect>();
  for (const factory of factories) {
    for (const workflow of factory.workflows) {
      workflowRects.set(workflow.workflow.id, {
        x: workflow.rect.x,
        y: workflow.rect.y,
        w: workflow.rect.w,
        h: workflow.rect.h,
      });
    }
  }

  const workflowRoutes = new Map<string, FactoryOverviewWorkflowRoute>();
  const factoryRoutes = new Map<
    string,
    { from: string; to: string; count: number }
  >();
  for (const edge of model.edges) {
    if (edge.kind !== "cross") continue;
    const from = modelWorkflows.get(edge.fromWorkflow);
    const to = modelWorkflows.get(edge.toWorkflow);
    if (!from || !to) continue;
    const fromKey = factoryKey(from.factoryName);
    const toKey = factoryKey(to.factoryName);
    if (fromKey === toKey) {
      if (!expanded || edge.fromWorkflow === edge.toWorkflow) continue;
      const routeKey = `${edge.fromWorkflow}>${edge.toWorkflow}`;
      if (workflowRoutes.has(routeKey)) continue;
      const fromRect = workflowRects.get(edge.fromWorkflow);
      const toRect = workflowRects.get(edge.toWorkflow);
      if (!fromRect || !toRect) continue;
      workflowRoutes.set(routeKey, {
        id: `factory-workflow-transition-${edge.fromWorkflow}-${edge.toWorkflow}`,
        from: edge.fromWorkflow,
        to: edge.toWorkflow,
        points: routePoints(fromRect, toRect),
      });
      continue;
    }
    const routeKey = `${fromKey}>${toKey}`;
    const route = factoryRoutes.get(routeKey);
    if (route) route.count += 1;
    else factoryRoutes.set(routeKey, { from: fromKey, to: toKey, count: 1 });
  }

  const factoryRoutesWithPoints: FactoryOverviewFactoryRoute[] = [];
  for (const [key, route] of factoryRoutes) {
    const fromRect = factoryRects.get(route.from);
    const toRect = factoryRects.get(route.to);
    if (!fromRect || !toRect) continue;
    factoryRoutesWithPoints.push({
      id: `factory-transition-${key}`,
      ...route,
      points: routePoints(fromRect, toRect),
    });
  }

  const height =
    yByRow.length === 0
      ? OVERVIEW_PAD_Y * 2
      : yByRow[yByRow.length - 1] +
        rowHeights[rowHeights.length - 1] +
        OVERVIEW_PAD_Y;
  return {
    width:
      OVERVIEW_PAD_X * 2 +
      factoryColumns * factoryWidth +
      (factoryColumns - 1) * FACTORY_GAP_X,
    height,
    factories,
    workflowRoutes: [...workflowRoutes.values()],
    factoryRoutes: factoryRoutesWithPoints,
  };
}

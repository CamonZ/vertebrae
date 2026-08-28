import type { PipelineSummary } from "../../bindings";
import {
  factoryNames,
  NO_FACTORY_SCOPE,
  type FactoryFilterValue,
} from "../../utils/workflowFactory";
import { rayBox } from "./layout/geometry";
import type { AtlasModel, Point, Rect } from "./layout/types";

const FACTORY_W = 280;
const FACTORY_H = 150;
const FACTORY_GAP_X = 60;
const FACTORY_GAP_Y = 48;
const OVERVIEW_PAD_X = 32;
const OVERVIEW_PAD_Y = 24;
const MAX_FACTORY_COLUMNS = 2;

/** Stable key used to group the explicit `null` factory value. */
export const NO_FACTORY_KEY = "__no_factory__";

export interface FactoryOverviewGroup {
  name: string;
  scope: FactoryFilterValue;
  workflowCount: number;
  workItemCount: number;
  activeCount: number;
}

export interface FactoryOverviewNode extends FactoryOverviewGroup {
  rect: Rect;
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

/**
 * Lay out the unscoped factory surface as opaque nodes. Cross-factory
 * transitions are reduced to one route per factory pair, regardless of how
 * many workflow transitions produce that handoff.
 */
export function layoutFactoryOverview(
  model: AtlasModel,
  groups: FactoryOverviewGroup[]
): FactoryOverviewLayout {
  const factoryColumns = Math.min(
    MAX_FACTORY_COLUMNS,
    Math.max(1, groups.length)
  );
  const groupRows: FactoryOverviewGroup[][] = [];
  for (let i = 0; i < groups.length; i += factoryColumns) {
    groupRows.push(groups.slice(i, i + factoryColumns));
  }

  const rowHeights = groupRows.map(() => FACTORY_H);
  const yByRow: number[] = [];
  rowHeights.reduce((y, height, index) => {
    yByRow[index] = y;
    return y + height + FACTORY_GAP_Y;
  }, OVERVIEW_PAD_Y);

  const factories: FactoryOverviewNode[] = [];
  const factoryRects = new Map<string, Rect>();
  groups.forEach((group, index) => {
    const row = Math.floor(index / factoryColumns);
    const col = index % factoryColumns;
    const rect: Rect = {
      x: OVERVIEW_PAD_X + col * (FACTORY_W + FACTORY_GAP_X),
      y: yByRow[row],
      w: FACTORY_W,
      h: FACTORY_H,
    };
    const key = typeof group.scope === "string" ? group.scope : NO_FACTORY_KEY;
    factoryRects.set(key, rect);
    factories.push({ ...group, rect });
  });

  const modelWorkflows = new Map(model.workflows.map((w) => [w.id, w]));
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
    if (fromKey === toKey) continue;
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
      factoryColumns * FACTORY_W +
      (factoryColumns - 1) * FACTORY_GAP_X,
    height,
    factories,
    factoryRoutes: factoryRoutesWithPoints,
  };
}

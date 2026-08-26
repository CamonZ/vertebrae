import type { PipelineSummary } from "../../bindings";
import {
  factoryNames,
  NO_FACTORY_SCOPE,
  type FactoryFilterValue,
} from "../../utils/workflowFactory";
import { rayBox } from "./layout/geometry";
import type { AtlasModel, AtlasWorkflow, Point, Rect } from "./layout/types";

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
const MAX_CARD_COLUMNS = 2;

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
  rect: Rect;
  shape: AtlasModel["steps"][number]["kind"][];
}

export interface FactoryOverviewNode extends FactoryOverviewGroup {
  rect: Rect;
  workflows: FactoryOverviewWorkflow[];
}

/** One visible workflow-to-workflow route inside a factory. */
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
 * Lay out the unscoped factory surface as factory containers containing the
 * same workflow cards used by the Map/Graph views. Cross-factory transitions
 * are intentionally reduced to one route per factory pair; transitions between
 * workflows in the same factory stay visible as workflow routes.
 */
export function layoutFactoryOverview(
  model: AtlasModel,
  groups: FactoryOverviewGroup[]
): FactoryOverviewLayout {
  const factoryColumns = Math.min(MAX_CARD_COLUMNS, Math.max(1, groups.length));
  const cardsPerFactory = MAX_CARD_COLUMNS;
  const factoryWidth =
    FACTORY_PAD_X * 2 +
    cardsPerFactory * CARD_W +
    (cardsPerFactory - 1) * CARD_GAP;
  const groupRows: FactoryOverviewGroup[][] = [];
  for (let i = 0; i < groups.length; i += factoryColumns) {
    groupRows.push(groups.slice(i, i + factoryColumns));
  }

  const factoryHeight = (group: FactoryOverviewGroup): number => {
    const rows = Math.max(
      1,
      Math.ceil(group.workflowIds.length / cardsPerFactory)
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

  const modelWorkflows = new Map(model.workflows.map((w) => [w.id, w]));
  const modelSteps = new Map<string, AtlasModel["steps"]>();
  for (const step of model.steps) {
    const list = modelSteps.get(step.workflowId);
    if (list) list.push(step);
    else modelSteps.set(step.workflowId, [step]);
  }

  const factories: FactoryOverviewNode[] = [];
  const workflowRects = new Map<string, Rect>();
  const factoryRects = new Map<string, Rect>();

  groups.forEach((group, index) => {
    const row = Math.floor(index / factoryColumns);
    const col = index % factoryColumns;
    const rect: Rect = {
      x: OVERVIEW_PAD_X + col * (factoryWidth + FACTORY_GAP_X),
      y: yByRow[row],
      w: factoryWidth,
      h: factoryHeight(group),
    };
    const workflows = group.workflowIds
      .map((id, workflowIndex) => {
        const workflow = modelWorkflows.get(id);
        if (!workflow) return null;
        const cardCol = workflowIndex % cardsPerFactory;
        const cardRow = Math.floor(workflowIndex / cardsPerFactory);
        const cardRect: Rect = {
          x: rect.x + FACTORY_PAD_X + cardCol * (CARD_W + CARD_GAP),
          y: rect.y + FACTORY_PAD_TOP + cardRow * (CARD_H + CARD_GAP),
          w: CARD_W,
          h: CARD_H,
        };
        workflowRects.set(workflow.id, cardRect);
        return {
          workflow,
          rect: cardRect,
          shape: workflow.stepIds
            .map((stepId) =>
              modelSteps
                .get(workflow.id)
                ?.find((step) => step.stepId === stepId)
            )
            .filter((step): step is NonNullable<typeof step> => !!step)
            .map((step) => step.kind),
        };
      })
      .filter((workflow): workflow is FactoryOverviewWorkflow => !!workflow);
    const key = typeof group.scope === "string" ? group.scope : NO_FACTORY_KEY;
    factoryRects.set(key, rect);
    factories.push({ ...group, rect, workflows });
  });

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
      const routeKey = `${edge.fromWorkflow}>${edge.toWorkflow}`;
      if (!workflowRoutes.has(routeKey)) {
        const fromRect = workflowRects.get(edge.fromWorkflow);
        const toRect = workflowRects.get(edge.toWorkflow);
        if (fromRect && toRect) {
          workflowRoutes.set(routeKey, {
            id: `factory-workflow-transition-${edge.fromWorkflow}-${edge.toWorkflow}`,
            from: edge.fromWorkflow,
            to: edge.toWorkflow,
            points: routePoints(fromRect, toRect),
          });
        }
      }
    } else {
      const routeKey = `${fromKey}>${toKey}`;
      const route = factoryRoutes.get(routeKey);
      if (route) route.count += 1;
      else factoryRoutes.set(routeKey, { from: fromKey, to: toKey, count: 1 });
    }
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

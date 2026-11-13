import type { PipelineSummary } from "../../bindings";
import {
  factoryNames,
  NO_FACTORY_SCOPE,
  type FactoryFilterValue,
} from "../../utils/workflowFactory";
import { rayBox } from "./layout/geometry";
import type { AtlasModel, Point, Rect } from "./layout/types";

const COLLAPSED_FACTORY_W = 280;
const COLLAPSED_FACTORY_H = 150;
const FACTORY_PAD_X = 42;
const FACTORY_PAD_TOP = 48;
const FACTORY_PAD_BOTTOM = 28;
const CANVAS_PAD = 32;

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

/** A dashed grouping region around the original workflow layout. */
export interface FactoryOverviewRegion extends FactoryOverviewGroup {
  rect: Rect;
}

/** The opaque low-zoom replacement for a factory region. */
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
  /** Translation that makes the padded region bounds fit in the canvas. */
  offsetX: number;
  offsetY: number;
  regions: FactoryOverviewRegion[];
  factories: FactoryOverviewNode[];
  factoryRoutes: FactoryOverviewFactoryRoute[];
}

function factoryKey(factoryName: string | null): string {
  return factoryName === null ? NO_FACTORY_KEY : factoryName;
}

/** Stable key for a factory group, matching the keys used by factory routes. */
export function factoryGroupKey(group: { scope: FactoryFilterValue }): string {
  return typeof group.scope === "string" ? group.scope : NO_FACTORY_KEY;
}

/** Key for any factory scope; `null` (all factories) has no key. */
export function factoryScopeKey(scope: FactoryFilterValue): string | null {
  if (scope === null) return null;
  return typeof scope === "string" ? scope : NO_FACTORY_KEY;
}

/** Count the distinct other factories each factory exchanges work with. */
export function factoryLinkCounts(
  routes: readonly { from: string; to: string }[]
): Map<string, number> {
  const neighbours = new Map<string, Set<string>>();
  const link = (from: string, to: string) => {
    const set = neighbours.get(from) ?? new Set<string>();
    set.add(to);
    neighbours.set(from, set);
  };
  for (const route of routes) {
    link(route.from, route.to);
    link(route.to, route.from);
  }
  return new Map([...neighbours].map(([key, set]) => [key, set.size] as const));
}

/**
 * Nudge fixed-size screen rects downward until none overlap. Factories whose
 * regions share a centre would otherwise stack their markers on top of each
 * other; a short downward shift keeps every name readable and clickable.
 */
export function separateRects(rects: readonly Rect[], gap: number): Rect[] {
  const order = rects
    .map((rect, index) => ({ rect, index }))
    .sort((a, b) => a.rect.y - b.rect.y || a.rect.x - b.rect.x);
  const placed: Rect[] = [];
  const result: Rect[] = new Array(rects.length);
  for (const { rect, index } of order) {
    let y = rect.y;
    let moved = true;
    while (moved) {
      moved = false;
      for (const other of placed) {
        const overlapsX =
          rect.x < other.x + other.w + gap && other.x < rect.x + rect.w + gap;
        const overlapsY =
          y < other.y + other.h + gap && other.y < y + rect.h + gap;
        if (overlapsX && overlapsY) {
          y = other.y + other.h + gap;
          moved = true;
        }
      }
    }
    const next = { ...rect, y };
    placed.push(next);
    result[index] = next;
  }
  return result;
}

/** Straight route between two boxes, clipped to each box's border. */
export function routePoints(from: Rect, to: Rect): Point[] {
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

function translatedRect(rect: Rect, offsetX: number, offsetY: number): Rect {
  return { ...rect, x: rect.x + offsetX, y: rect.y + offsetY };
}

/**
 * Place the factory overlay over an already-laid-out workflow canvas.
 *
 * The workflow rectangles are deliberately supplied by `layoutFull` or
 * `layoutCondensed`: factories do not get their own grid or nested workflow
 * layout. Their high-zoom regions and low-zoom summary nodes are two views of
 * the same geometry.
 */
export function layoutFactoryOverview(
  model: AtlasModel,
  groups: FactoryOverviewGroup[],
  workflowRects: ReadonlyMap<string, Rect>,
  contentWidth: number,
  contentHeight: number
): FactoryOverviewLayout {
  const rawRegions: FactoryOverviewRegion[] = [];

  for (const group of groups) {
    const rects = group.workflowIds
      .map((id) => workflowRects.get(id))
      .filter((rect): rect is Rect => !!rect);
    if (rects.length === 0) continue;

    const left = Math.min(...rects.map((rect) => rect.x)) - FACTORY_PAD_X;
    const top = Math.min(...rects.map((rect) => rect.y)) - FACTORY_PAD_TOP;
    const right =
      Math.max(...rects.map((rect) => rect.x + rect.w)) + FACTORY_PAD_X;
    const bottom =
      Math.max(...rects.map((rect) => rect.y + rect.h)) + FACTORY_PAD_BOTTOM;
    rawRegions.push({
      ...group,
      rect: { x: left, y: top, w: right - left, h: bottom - top },
    });
  }

  const minX = Math.min(0, ...rawRegions.map((region) => region.rect.x));
  const minY = Math.min(0, ...rawRegions.map((region) => region.rect.y));
  const maxX = Math.max(
    contentWidth,
    ...rawRegions.map((region) => region.rect.x + region.rect.w)
  );
  const maxY = Math.max(
    contentHeight,
    ...rawRegions.map((region) => region.rect.y + region.rect.h)
  );
  const offsetX = -minX + CANVAS_PAD;
  const offsetY = -minY + CANVAS_PAD;

  const regions = rawRegions.map((region) => ({
    name: region.name,
    scope: region.scope,
    workflowIds: region.workflowIds,
    workflowCount: region.workflowCount,
    workItemCount: region.workItemCount,
    activeCount: region.activeCount,
    rect: translatedRect(region.rect, offsetX, offsetY),
  }));

  const factories: FactoryOverviewNode[] = regions.map((region) => ({
    ...region,
    rect: {
      x: region.rect.x + (region.rect.w - COLLAPSED_FACTORY_W) / 2,
      y: region.rect.y + (region.rect.h - COLLAPSED_FACTORY_H) / 2,
      w: COLLAPSED_FACTORY_W,
      h: COLLAPSED_FACTORY_H,
    },
  }));

  const factoryRects = new Map<string, Rect>();
  factories.forEach((factory) => {
    factoryRects.set(factoryGroupKey(factory), factory.rect);
  });

  const factoryRoutes = new Map<
    string,
    { from: string; to: string; count: number }
  >();
  const workflowById = new Map(
    model.workflows.map((workflow) => [workflow.id, workflow])
  );

  for (const edge of model.edges) {
    if (edge.kind !== "cross") continue;
    const from = workflowById.get(edge.fromWorkflow);
    const to = workflowById.get(edge.toWorkflow);
    if (!from || !to) continue;
    const fromKey = factoryKey(from.factoryName);
    const toKey = factoryKey(to.factoryName);
    if (fromKey === toKey) continue;
    const routeKey = `${fromKey}>${toKey}`;
    const route = factoryRoutes.get(routeKey);
    if (route) route.count += 1;
    else factoryRoutes.set(routeKey, { from: fromKey, to: toKey, count: 1 });
  }

  const routes: FactoryOverviewFactoryRoute[] = [];
  for (const [key, route] of factoryRoutes) {
    const fromRect = factoryRects.get(route.from);
    const toRect = factoryRects.get(route.to);
    if (!fromRect || !toRect) continue;
    routes.push({
      id: `factory-transition-${key}`,
      ...route,
      points: routePoints(fromRect, toRect),
    });
  }

  return {
    width: maxX - minX + CANVAS_PAD * 2,
    height: maxY - minY + CANVAS_PAD * 2,
    offsetX,
    offsetY,
    regions,
    factories,
    factoryRoutes: routes,
  };
}

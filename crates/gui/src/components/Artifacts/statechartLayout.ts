import type { ElkNode, ElkExtendedEdge } from "elkjs/lib/elk.bundled.js";
import type {
  Statechart,
  StatechartNode,
  StatechartTransition,
} from "./statechart";

type Point = { x: number; y: number };
export type PlacedState = StatechartNode &
  Point & { width: number; height: number; region: boolean };
export type PlacedTransition = StatechartTransition & {
  points: Point[];
  label: string;
  labelPosition: Point;
  initial: boolean;
};
export type StatechartLayout = {
  width: number;
  height: number;
  states: PlacedState[];
  transitions: PlacedTransition[];
  initials: (Point & { id: string; owner: string })[];
};

export function wrapStatechartText(text: string, length = 28): string[] {
  const characters = Array.from(text);
  const lines: string[] = [];

  for (let index = 0; index < characters.length; index += length) {
    const line = characters.slice(index, index + length).join("");
    lines.push(line);
  }

  return lines.length ? lines : [""];
}

/** Native hierarchical layout; XState's resolved nodes/targets remain authoritative. */
export async function layoutStatechart(
  machine: Statechart
): Promise<StatechartLayout> {
  const transitions = [...machine.transitions];
  const initialOwners = new Map<string, string>();

  function build(node: StatechartNode): ElkNode {
    const children = node.children.map(build);
    const labelLines = wrapStatechartText(node.label, 24);
    const headerHeight = Math.max(48, labelLines.length * 18 + 24);

    for (const target of node.initial) {
      const id = `$initial:${node.id}`;
      initialOwners.set(id, node.id);
      children.unshift({ id, width: 16, height: 16 });
      transitions.push({
        id: `initial-${node.id}`,
        source: id,
        target,
        event: "",
        eventType: "",
        kind: "event",
        reenter: false,
      });
    }

    // ELK's JSON bridge distinguishes an absent size from an explicit
    // undefined value. Containers are sized from their children.
    const shape = children.length
      ? { children }
      : { width: 210, height: Math.max(72, headerHeight + 12) };

    return {
      id: node.id,
      ...shape,
      layoutOptions: {
        "elk.direction": node.type === "parallel" ? "RIGHT" : "DOWN",
        "elk.padding": `[top=${headerHeight + 20},left=24,bottom=24,right=24]`,
        "elk.spacing.nodeNode": "44",
        "elk.layered.spacing.nodeNodeBetweenLayers": "72",
      },
    };
  }

  const root = build(machine.root);
  const graphNodes = new Map<string, ElkNode>();
  const parents = new Map<string, string>();

  function index(node: ElkNode, parent: string) {
    graphNodes.set(node.id, node);
    parents.set(node.id, parent);

    for (const child of node.children ?? []) index(child, node.id);
  }

  index(root, "$canvas");

  const edges: ElkExtendedEdge[] = transitions.map((transition) => {
    const guard = transition.guard ? ` [${transition.guard}]` : "";
    const internal = transition.kind === "internal" ? " (internal)" : "";
    const label = `${transition.event}${guard}${internal}`;
    const lines = wrapStatechartText(label);

    return {
      id: transition.id,
      sources: [transition.source],
      targets: [transition.target],
      labels: label
        ? [
            {
              text: label,
              width: Math.min(28, label.length) * 7 + 12,
              height: lines.length * 16 + 8,
            },
          ]
        : [],
    };
  });
  const graph: ElkNode = {
    id: "$canvas",
    children: [root],
    edges: [],
    layoutOptions: {
      "elk.algorithm": "layered",
      "elk.direction": "DOWN",
      "elk.hierarchyHandling": "INCLUDE_CHILDREN",
      "elk.edgeRouting": "ORTHOGONAL",
      "elk.padding": "[top=20,left=20,bottom=20,right=20]",
      "elk.layered.spacing.edgeNodeBetweenLayers": "28",
      "elk.spacing.edgeLabel": "10",
    },
  };

  graphNodes.set(graph.id, graph);

  // ELK expects each edge in the lowest common containing graph, rather
  // than collecting all nested transitions on the outer canvas.
  for (const edge of edges) {
    const sourceAncestors = new Set<string>();
    let ancestor = parents.get(edge.sources[0]);

    while (ancestor) {
      sourceAncestors.add(ancestor);
      ancestor = parents.get(ancestor);
    }

    let owner = parents.get(edge.targets[0]);

    while (owner && !sourceAncestors.has(owner)) owner = parents.get(owner);

    const container = graphNodes.get(owner ?? graph.id)!;
    container.edges ??= [];
    container.edges.push(edge);
  }

  const { default: ELK } = await import("elkjs/lib/elk.bundled.js");
  const elk = new ELK();
  const placed = await elk.layout(graph);
  const states: PlacedState[] = [];
  const initials: StatechartLayout["initials"] = [];
  const positions = new Map<string, Point>();
  const stateEntries = machine.nodes.map((node) => [node.id, node] as const);
  const semantics = new Map(stateEntries);
  const routed: { edge: ElkExtendedEdge; parent: string }[] = [];

  function collect(node: ElkNode, offset: Point) {
    const x = offset.x + (node.x ?? 0);
    const y = offset.y + (node.y ?? 0);
    const position = { x, y };
    positions.set(node.id, position);

    const state = semantics.get(node.id);
    const owner = initialOwners.get(node.id);

    if (state) {
      const parent = state.parentId ? semantics.get(state.parentId) : undefined;
      states.push({
        ...state,
        x,
        y,
        width: node.width ?? 210,
        height: node.height ?? 72,
        region: parent?.type === "parallel",
      });
    } else if (owner) {
      initials.push({ id: node.id, owner, x: x + 8, y: y + 8 });
    }

    for (const edge of node.edges ?? []) routed.push({ edge, parent: node.id });
    for (const child of node.children ?? []) collect(child, position);
  }

  collect(placed, { x: 0, y: 0 });

  const transitionEntries = transitions.map(
    (transition) => [transition.id, transition] as const
  );
  const definitions = new Map(transitionEntries);
  const paths: PlacedTransition[] = routed.map(({ edge, parent }) => {
    const definition = definitions.get(edge.id);
    const container = positions.get(edge.container ?? parent);
    const section = edge.sections?.[0];

    if (!definition || !container || !section)
      throw new Error("Statechart layout did not resolve a transition.");

    const route = [
      section.startPoint,
      ...(section.bendPoints ?? []),
      section.endPoint,
    ];
    const points = route.map((point) => ({
      x: point.x + container.x,
      y: point.y + container.y,
    }));
    const guard = definition.guard ? ` [${definition.guard}]` : "";
    const internal = definition.kind === "internal" ? " (internal)" : "";
    const label = `${definition.event}${guard}${internal}`;
    const placedLabel = edge.labels?.[0];
    const middle = points[Math.floor(points.length / 2)];
    const labelPosition = placedLabel
      ? {
          x: (placedLabel.x ?? 0) + container.x,
          y: (placedLabel.y ?? 0) + container.y,
        }
      : middle;

    return {
      ...definition,
      points,
      label,
      labelPosition,
      initial: initialOwners.has(definition.source),
    };
  });

  if (paths.length !== transitions.length)
    throw new Error("Statechart layout omitted transitions.");

  return {
    width: placed.width ?? 600,
    height: placed.height ?? 400,
    states,
    transitions: paths,
    initials,
  };
}

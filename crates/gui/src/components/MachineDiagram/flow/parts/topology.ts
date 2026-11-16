/** Workflow topology is a transition graph, independent of story card conversions. */
import type { AnyPartKind, PortDef } from "../registry";
import { sideGates } from "./common";

export const topologyField = {
  type: "boolean",
  default: false,
  description:
    "show configured structure without an observed execution; defaults to scale 1 for readable detail labels across all arrangements; explicit scale overrides this",
} as const;

export const transitionTokens = [
  "payload",
  "request",
  "data",
  "result",
] as const;

/** Retain story token validation unless the instance explicitly requests topology. */
export function topologyPorts(ports: Readonly<Record<string, PortDef>>) {
  return Object.fromEntries(
    Object.entries(ports)
      .filter(([name]) => name === "in" || name === "out")
      .map(([name, port]) => [name, { ...port, tokens: transitionTokens }])
  );
}

export function workflowTopology(def: AnyPartKind): AnyPartKind {
  return {
    ...def,
    props: { ...def.props, topology: topologyField },
    resolve: (props) => {
      const resolved = def.resolve?.(props) ?? {};
      if (!props.topology) return resolved;
      const ports = topologyPorts(resolved.ports ?? def.ports);
      return {
        ...resolved,
        neutral: true,
        ports,
        gates: () => sideGates(ports),
      };
    },
  };
}

/**
 * A station (workflow or factory) drawn as configured structure: no observed
 * status line, and every station port kept (unlike step parts, a station's
 * ports are its transitions). Live counts come from the host's presentation.
 */
export function stationTopology(def: AnyPartKind): AnyPartKind {
  return {
    ...def,
    props: {
      ...def.props,
      topology: {
        ...topologyField,
        description:
          "show configured structure without an observed execution (no status line); ports are unchanged",
      },
    },
    resolve: (props) => {
      const resolved = def.resolve?.(props) ?? {};
      return props.topology ? { ...resolved, neutral: true } : resolved;
    },
  };
}

/** Injective UTF-16 encoding: punctuation, Unicode and names resembling defaults stay distinct. */
export function decisionPort(name: string): string {
  return `rule_${Array.from({ length: name.length }, (_, i) =>
    name.charCodeAt(i).toString(16).padStart(4, "0")
  ).join("")}`;
}

export interface RouteTopologyProps {
  readonly decisions?: readonly string[];
  readonly defaultDecision?: boolean;
}

/** Ordered rows reserve enough horizontal and vertical room for complete labels. */
export function routeTopology(props: RouteTopologyProps) {
  const names = Array.isArray(props.decisions)
    ? props.decisions.filter((name): name is string => typeof name === "string")
    : [];
  const labels = [
    ...names.map((label) => ({ id: decisionPort(label), label })),
    ...(props.defaultDecision ? [{ id: "default", label: "default" }] : []),
  ];
  const width = Math.max(
    200,
    ...labels.map(({ label }) => label.length * 18 + 96)
  );
  const height = Math.max(120, 40 + labels.length * 40);
  const bb = [200, 110, width, height] as const;
  const rows = labels.map((row, i) => ({
    ...row,
    x: 200 + width,
    y: 150 + i * 40,
  }));
  const ports: Record<string, PortDef> = {
    in: {
      side: "W",
      x: 200,
      y: 200,
      direction: "in",
      tokens: transitionTokens,
    },
    ...Object.fromEntries(
      rows.map((row) => [
        row.id,
        {
          side: "E",
          x: row.x,
          y: row.y,
          direction: "out",
          tokens: transitionTokens,
          description: row.label,
        } satisfies PortDef,
      ])
    ),
  };
  return {
    bb,
    rows,
    ports,
    status: { x: 200 + width / 2, y: 110 + height + 32 },
  };
}

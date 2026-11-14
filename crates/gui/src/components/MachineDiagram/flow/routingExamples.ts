import type { FlowSpec } from "./spec";

/** Synthetic routing regressions, also rendered in the dev gallery. */
export const ROUTING_EXAMPLES: readonly { name: string; spec: FlowSpec }[] = [
  {
    name: "Backward edge and store loop",
    spec: {
      version: 1,
      parts: [
        { id: "worker", kind: "worker" },
        { id: "store", kind: "store" },
      ],
      rails: [
        { id: "back", from: "store.out", to: "worker.in" },
        { id: "loop", from: "store.out", to: "store.in" },
      ],
    },
  },
  {
    name: "Stacked self-loops",
    spec: {
      version: 1,
      parts: [
        { id: "upper", kind: "aggregator" },
        { id: "lower", kind: "aggregator" },
      ],
      rails: [
        { id: "upper-loop", from: "upper.out", to: "upper.in" },
        { id: "lower-loop", from: "lower.out", to: "lower.in" },
      ],
    },
  },
  {
    name: "Upper port loop beside a branch",
    spec: {
      version: 1,
      parts: [
        { id: "route", kind: "route step" },
        { id: "schema", kind: "schema" },
      ],
      rails: [
        { id: "loop", from: "route.out1", to: "route.in" },
        { id: "branch", from: "route.out2", to: "schema.in" },
      ],
    },
  },
  {
    name: "Two returns from one port",
    spec: {
      version: 1,
      parts: [
        { id: "first", kind: "aggregator" },
        { id: "second", kind: "aggregator" },
      ],
      rails: [
        { id: "back", from: "second.out", to: "first.in" },
        { id: "loop", from: "second.out", to: "second.in" },
      ],
    },
  },
  {
    name: "Fixed-port K3,3",
    spec: {
      version: 1,
      parts: Array.from({ length: 6 }, (_, i) => ({
        id: `p${i}`,
        kind: "aggregator",
      })),
      rails: Array.from({ length: 9 }, (_, i) => ({
        id: `r${i}`,
        from: `p${Math.floor(i / 3)}.out`,
        to: `p${3 + (i % 3)}.in`,
      })),
    },
  },
  {
    name: "Parallel bus tracks",
    spec: {
      version: 1,
      parts: [
        { id: "route", kind: "route step" },
        { id: "join", kind: "joiner" },
      ],
      rails: [
        { id: "top", from: "route.out1", to: "join.a", label: "first" },
        { id: "bottom", from: "route.out2", to: "join.b", label: "second" },
      ],
    },
  },
  {
    name: "Same-side bus corners",
    spec: {
      version: 1,
      parts: [
        { id: "a", kind: "quorum" },
        { id: "b", kind: "quorum" },
      ],
      rails: [
        { id: "top", from: "a.r1", to: "b.r3", label: "first" },
        { id: "bottom", from: "a.r2", to: "b.r2", label: "second" },
      ],
    },
  },
  {
    name: "Loops that wrap a neighbour",
    spec: {
      version: 1,
      parts: [
        { id: "route", kind: "route step" },
        { id: "left", kind: "aggregator" },
        { id: "right", kind: "aggregator" },
      ],
      rails: [
        { id: "loop1", from: "route.out1", to: "route.in" },
        { id: "loop2", from: "route.out2", to: "route.in" },
        { id: "loop3", from: "route.out3", to: "route.in" },
        { id: "a", from: "route.out3", to: "left.in" },
        { id: "b", from: "route.out2", to: "left.in" },
        { id: "c", from: "route.out1", to: "right.in" },
        { id: "d", from: "route.out2", to: "right.in" },
      ],
    },
  },
];

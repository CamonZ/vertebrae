import { afterEach, expect, test, vi } from "vitest";
import { compileFlowOrThrow, type DiagramRail } from "./compile";
import { routeByTopology, type FaceEnd, type FaceRouting } from "./faceRouter";
import * as topology from "./portTopology";
import { ROUTING_EXAMPLES } from "./routingExamples";

afterEach(() => vi.restoreAllMocks());

test.each([
  { drawn: false, attempts: 1 },
  { drawn: true, attempts: 2 },
])(
  "non-planar routing avoids redundant empty-order retries (drawn: $drawn)",
  ({ drawn, attempts }) => {
    // Exercise the real compiler and non-planarity search. The spy observes work
    // without replacing the embedding algorithm or relying on wall-clock timing.
    const diagram = compileFlowOrThrow(
      ROUTING_EXAMPLES.find((example) => example.name === "Fixed-port K3,3")!
        .spec
    ).arrangements[0];
    const end = (ref: DiagramRail["from"], at: FaceEnd["at"]): FaceEnd => {
      const part = diagram.parts.find((p) => p.id === ref.part)!;
      return { ...ref, at, border: at, side: part.ports[ref.port].side };
    };
    const input: FaceRouting = {
      diagram,
      rails: diagram.rails.map((rail) => ({
        id: rail.id,
        from: end(rail.from, rail.points[0]),
        to: end(rail.to, rail.points.at(-1)!),
        ...(drawn ? { route: rail } : {}),
        movable: false,
      })),
      parts: [],
      soft: [],
      preference: [],
      gap: 20,
      stub: 14,
      labelBox: () => ({ x0: 0, x1: 0, y0: 0, y1: 0 }),
      placeLabel: () => undefined,
    };
    const embedding = vi.spyOn(topology, "portEmbedding");
    expect(routeByTopology(input)).toBeUndefined();
    expect(embedding).toHaveBeenCalledTimes(attempts);
    expect(embedding.mock.calls[0][2]!.size > 0).toBe(drawn);
    expect(embedding.mock.calls.at(-1)![2]!.size).toBe(0);
  }
);

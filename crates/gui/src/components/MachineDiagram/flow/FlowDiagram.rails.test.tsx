import { drawnLeads } from "./railTestHelpers";
import { cleanup, render } from "@testing-library/react";
import { afterEach, expect, test } from "vitest";
import * as hegel from "@hegeldev/hegel";
import * as gs from "@hegeldev/hegel/generators";
import { MachineDiagram } from "../MachineDiagram";
import { CatalogPart, MACHINE_PARTS, type MachinePartDef } from "../parts";
import { route, routePath } from "../route";
import { world } from "./arrangementWorlds";
import { compileFlowOrThrow } from "./compile";
import { FlowDiagram } from "./FlowDiagram";

afterEach(cleanup);

/**
 * Rails a part keeps inside a flow (its own tracks and links to what it
 * draws in its cell); every other gallery rail is a lead the flow's wires
 * replace. Reviewed against the gallery part by part.
 */
const MECHANISM_RAILS: Record<string, number> = {
  alert: 2,
  approval: 1,
  boundary: 1,
  cache: 2,
  "circuit breaker": 1,
  "event rail": 1,
  "event store": 1,
  "execute step": 3,
  factory: 2,
  "failure detector": 1,
  "fencing token": 2,
  guard: 1,
  "idempotency guard": 1,
  "inference step": 1,
  outbox: 1,
  quorum: 3,
  "reactive cell": 2,
  replication: 2,
  retry: 2,
  "run end": 1,
  saga: 3,
  "service registry": 4,
  "task run": 1,
  "two-phase commit": 3,
  upcaster: 1,
  "version vector": 1,
  workflow: 1,
};

const PARTS = Object.entries(MACHINE_PARTS).map(
  ([kind, def]) => [kind, def as unknown as MachinePartDef] as const
);

test.each(PARTS)(
  "%s keeps its gallery rails but has no leads in an unconnected flow",
  (kind, def) => {
    const gallery = render(
      <MachineDiagram label="gallery">
        <CatalogPart
          def={def}
          view={{ kind: "scenario", index: 0, t: def.scenarios[0].still }}
        />
      </MachineDiagram>
    );
    const galleryRails = gallery.container.querySelectorAll(".md-rail").length;
    gallery.unmount();
    // Exercise the actual flow adapters, including the protocol drawings.
    const flow = compileFlowOrThrow({
      version: 1,
      parts: [{ id: "alone", kind }],
      rails: [],
      cards: [],
      story: [],
    });
    for (const mode of ["embedded", "full-page"] as const) {
      for (const diagram of flow.arrangements) {
        const drawn = render(
          <FlowDiagram diagram={diagram} mode={mode} t={0} reducedMotion />
        );
        expect(
          drawn.container.querySelector("[data-part-id='alone']")
        ).not.toBeNull();
        expect(drawn.container.querySelectorAll(".md-wire")).toHaveLength(0);
        expect(drawnLeads(drawn.container)).toEqual([]);
        expect(
          drawn.container.querySelectorAll(".md-rail").length,
          "mechanism rails drawn in a flow"
        ).toBe(MECHANISM_RAILS[kind] ?? 0);
        drawn.unmount();
      }
    }
    const again = render(
      <MachineDiagram label="gallery">
        <CatalogPart
          def={def}
          view={{ kind: "scenario", index: 0, t: def.scenarios[0].still }}
        />
      </MachineDiagram>
    );
    expect(again.container.querySelectorAll(".md-rail")).toHaveLength(
      galleryRails
    );
  }
);

test("generated flows draw exactly their compiled rail paths", () =>
  hegel.test(
    (tc) => {
      const flow = compileFlowOrThrow(tc.draw(world).spec);
      const diagram = tc.draw(gs.sampledFrom(flow.arrangements));
      const t = tc.draw(gs.floats({ minValue: 0, maxValue: diagram.period }));
      const drawn = render(
        <FlowDiagram
          diagram={diagram}
          mode={tc.draw(gs.sampledFrom(["embedded", "full-page"] as const))}
          t={t}
          reducedMotion
        />
      );
      try {
        expect(drawnLeads(drawn.container)).toEqual([]);
        const paths = Array.from(
          drawn.container.querySelectorAll(".md-wire path.gedge"),
          (path) => path.getAttribute("d")
        );
        expect(paths).toEqual(
          diagram.rails
            .filter((rail) => rail.presence !== "absent")
            .map((rail) => routePath(route(rail.points, undefined, rail)))
        );
      } finally {
        drawn.unmount();
      }
    },
    { testCases: 200 }
  ));

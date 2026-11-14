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
    for (const diagram of flow.arrangements) {
      const drawn = render(
        <FlowDiagram diagram={diagram} t={0} reducedMotion />
      );
      expect(
        drawn.container.querySelector("[data-part-id='alone']")
      ).not.toBeNull();
      expect(
        drawn.container.querySelectorAll(".md-rail, .md-wire")
      ).toHaveLength(0);
      drawn.unmount();
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
        <FlowDiagram diagram={diagram} t={t} reducedMotion />
      );
      try {
        expect(drawn.container.querySelectorAll(".md-rail")).toHaveLength(0);
        const paths = Array.from(
          drawn.container.querySelectorAll(".md-wire path.gedge"),
          (path) => path.getAttribute("d")
        );
        expect(paths).toEqual(
          diagram.rails
            .filter((rail) => rail.presence !== "absent")
            .map((rail) => routePath(route(rail.points)))
        );
      } finally {
        drawn.unmount();
      }
    },
    { testCases: 200 }
  ));

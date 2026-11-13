import * as hegel from "@hegeldev/hegel";
import * as gs from "@hegeldev/hegel/generators";
import { cleanup, render, screen } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import { AttachmentPanel } from "./AttachmentPanel";
import {
  AttachmentRenderersContext,
  attachmentRenderers,
} from "./attachmentRenderers";
import { compileFlow } from "./compile";
import { createFlowRegistry } from "./defaults";
import type { FieldSchema } from "./fields";
import { FlowRegistryContext } from "./registryContext";
import type { AttachmentSpec, FlowSpec } from "./spec";
import { validateFlowSpec } from "./validate";

it("registered schemas validate, compile and render generated evidence without host changes", () =>
  hegel.test(
    (tc) => {
      const kind = `extension-${tc.draw(gs.integers({ minValue: 0, maxValue: 10000 }))}`;
      const field = tc.draw(gs.sampledFrom(["value", "measurement", "detail"]));
      const type = tc.draw(
        gs.sampledFrom(["string", "integer", "boolean"] as const)
      );
      const value =
        type === "string"
          ? tc.draw(gs.text({ maxSize: 50 }))
          : type === "integer"
            ? tc.draw(gs.integers({ minValue: -10000, maxValue: 10000 }))
            : tc.draw(gs.booleans());

      const status = tc.draw(gs.sampledFrom(["verified", "inferred"] as const));
      const source = tc.draw(gs.sampledFrom(["scenario", "trace"] as const));

      const attachment: AttachmentSpec = {
        kind,
        id: "generated-evidence",
        [field]: value,
        status,
        source,
      };

      const registry = createFlowRegistry();
      const renderer = vi.fn((a: AttachmentSpec) => (
        <output aria-label="Custom evidence">{JSON.stringify(a[field])}</output>
      ));
      const definition = {
        kind,
        description: "Generated kind",
        fields: { [field]: { type, required: true } as FieldSchema },
      };
      registry.attachments.register(definition);

      const spec = (a: AttachmentSpec): FlowSpec => ({
        version: 1,
        parts: [{ id: "client", kind: "client" }],
        attachments: [a],
      });

      try {
        expect(validateFlowSpec(spec(attachment), registry)).toEqual([]);

        const compiled = compileFlow(spec(attachment), { registry });
        if (!compiled.ok) throw new Error(JSON.stringify(compiled.errors));
        expect(compiled.flow.attachments).toEqual([attachment]);

        render(
          <FlowRegistryContext.Provider value={registry}>
            <AttachmentRenderersContext.Provider
              value={{ ...attachmentRenderers, [kind]: renderer }}
            >
              <AttachmentPanel attachments={compiled.flow.attachments} />
            </AttachmentRenderersContext.Provider>
          </FlowRegistryContext.Provider>
        );

        expect(screen.getByLabelText("Custom evidence").textContent).toBe(
          JSON.stringify(value)
        );
        expect(screen.getByText(status)).toBeVisible();
        expect(
          screen.getByText(source === "trace" ? "recorded trace" : "scenario")
        ).toBeVisible();
        expect(renderer.mock.calls.at(-1)?.[0]).toEqual(attachment);

        expect(() => registry.attachments.register(definition)).toThrow(
          /already registered/
        );

        // Each schema gets both a wrong-typed value and a missing required value.
        const invalid = [
          { ...attachment, [field]: type === "string" ? 42 : "invalid" },
          { kind, status, source },
        ];
        const calls = renderer.mock.calls.length;

        for (const body of invalid) {
          const rejected = compileFlow(spec(body), { registry });

          expect(rejected.ok).toBe(false);
          if (!rejected.ok)
            expect(
              rejected.errors.some((e) => e.path === `attachments[0].${field}`)
            ).toBe(true);
        }

        expect(renderer).toHaveBeenCalledTimes(calls);

        expect(
          compileFlow(spec(attachment), { registry: createFlowRegistry() }).ok
        ).toBe(false);
      } finally {
        cleanup();
      }
    },
    { testCases: 100 }
  ));

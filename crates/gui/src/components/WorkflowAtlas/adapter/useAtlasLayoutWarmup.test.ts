import { describe, expect, it } from "vitest";
import { NO_FACTORY_SCOPE } from "../../../utils/workflowFactory";
import { step, workflow } from "./machineFlow.fixture";
import { atlasWarmupFlow, atlasWarmupLevels } from "./useAtlasLayoutWarmup";

const summary = {
  workflows: [
    { ...workflow("a", [step("a1", "llm_inference", 0)]), factory_name: "One" },
    { ...workflow("b", [step("b1", "llm_inference", 0)]), factory_name: "Two" },
    { ...workflow("c", [step("c1", "llm_inference", 0)]), factory_name: null },
  ],
};

describe("Atlas layout warm-up", () => {
  it("warms between factories, every factory and every workflow", () => {
    expect(atlasWarmupLevels(summary)).toEqual([
      { kind: "factories" },
      { kind: "workflows", factory: "One" },
      { kind: "workflows", factory: "Two" },
      { kind: "workflows", factory: NO_FACTORY_SCOPE },
      { kind: "steps", factory: "One", workflowId: "a" },
      { kind: "steps", factory: "Two", workflowId: "b" },
      { kind: "steps", factory: NO_FACTORY_SCOPE, workflowId: "c" },
    ]);
  });

  it("builds the same flow each level's Graph lays out", () => {
    const factories = atlasWarmupFlow(summary, new Map(), {
      kind: "factories",
    });
    expect(factories?.arrangements[0].parts.map((p) => p.kind)).toEqual([
      "factory",
      "factory",
      "factory",
    ]);
    const steps = atlasWarmupFlow(summary, new Map(), {
      kind: "steps",
      factory: "One",
      workflowId: "a",
    });
    expect(steps?.arrangements[0].regions.map((r) => r.label)).toEqual(["a"]);
  });
});

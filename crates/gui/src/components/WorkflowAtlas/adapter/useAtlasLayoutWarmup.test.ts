import { describe, expect, it } from "vitest";
import { NO_FACTORY_SCOPE } from "../../../utils/workflowFactory";
import { step, workflow } from "./machineFlow.fixture";
import { atlasWarmupFlow, atlasWarmupScopes } from "./useAtlasLayoutWarmup";

const summary = {
  workflows: [
    { ...workflow("a", [step("a1", "llm_inference", 0)]), factory_name: "One" },
    { ...workflow("b", [step("b1", "llm_inference", 0)]), factory_name: "Two" },
    { ...workflow("c", [step("c1", "llm_inference", 0)]), factory_name: null },
  ],
};

describe("Atlas layout warm-up", () => {
  it("warms every factory, the unassigned scope and the whole project", () => {
    expect(atlasWarmupScopes(summary)).toEqual([
      "One",
      "Two",
      NO_FACTORY_SCOPE,
      null,
    ]);
  });

  it("builds the same flow each scope's Graph lays out", () => {
    const one = atlasWarmupFlow(summary, new Map(), "One");
    expect(one?.arrangements[0].regions.map((r) => r.label)).toEqual(["a"]);
    const all = atlasWarmupFlow(summary, new Map(), null);
    expect(all?.arrangements[0].regions).toHaveLength(3);
  });
});

import { describe, it, expect, beforeEach } from "vitest";
import { useStepStore } from "./stepStore";
import { createMockStep } from "../test/test-utils";

describe("stepStore", () => {
  beforeEach(() => {
    useStepStore.setState({ steps: [] });
  });

  describe("initial state", () => {
    it("has empty steps array", () => {
      expect(useStepStore.getState().steps).toEqual([]);
    });
  });

  describe("setSteps", () => {
    it("sets the steps list", () => {
      const steps = [
        createMockStep({ id: "step-1", name: "backlog" }),
        createMockStep({ id: "step-2", name: "done" }),
      ];

      useStepStore.getState().setSteps(steps);

      const state = useStepStore.getState();
      expect(state.steps).toHaveLength(2);
      expect(state.steps[0].name).toBe("backlog");
      expect(state.steps[1].name).toBe("done");
    });

    it("replaces existing steps", () => {
      useStepStore.getState().setSteps([createMockStep({ id: "step-1" })]);
      useStepStore.getState().setSteps([createMockStep({ id: "step-2" })]);

      expect(useStepStore.getState().steps).toHaveLength(1);
      expect(useStepStore.getState().steps[0].id).toBe("step-2");
    });
  });

  describe("upsertStep", () => {
    it("adds a new step when it does not exist", () => {
      const step = createMockStep({ id: "step-new", name: "New Step" });

      useStepStore.getState().upsertStep(step);

      const state = useStepStore.getState();
      expect(state.steps).toHaveLength(1);
      expect(state.steps[0].id).toBe("step-new");
      expect(state.steps[0].name).toBe("New Step");
    });

    it("updates an existing step", () => {
      const original = createMockStep({ id: "step-1", name: "Original" });
      useStepStore.getState().setSteps([original]);

      const updated = createMockStep({ id: "step-1", name: "Updated" });
      useStepStore.getState().upsertStep(updated);

      const state = useStepStore.getState();
      expect(state.steps).toHaveLength(1);
      expect(state.steps[0].name).toBe("Updated");
    });

    it("preserves order when updating an existing step", () => {
      const steps = [
        createMockStep({ id: "step-1", name: "First" }),
        createMockStep({ id: "step-2", name: "Second" }),
        createMockStep({ id: "step-3", name: "Third" }),
      ];
      useStepStore.getState().setSteps(steps);

      useStepStore.getState().upsertStep(createMockStep({ id: "step-2", name: "Second Updated" }));

      const state = useStepStore.getState();
      expect(state.steps[0].id).toBe("step-1");
      expect(state.steps[1].id).toBe("step-2");
      expect(state.steps[1].name).toBe("Second Updated");
      expect(state.steps[2].id).toBe("step-3");
    });
  });

  describe("removeStep", () => {
    it("removes a step by ID", () => {
      const steps = [
        createMockStep({ id: "step-1", name: "First" }),
        createMockStep({ id: "step-2", name: "Second" }),
      ];
      useStepStore.getState().setSteps(steps);

      useStepStore.getState().removeStep("step-1");

      const state = useStepStore.getState();
      expect(state.steps).toHaveLength(1);
      expect(state.steps[0].id).toBe("step-2");
    });

    it("is a no-op when step ID does not exist", () => {
      useStepStore.getState().setSteps([createMockStep({ id: "step-1" })]);

      useStepStore.getState().removeStep("nonexistent");

      expect(useStepStore.getState().steps).toHaveLength(1);
    });
  });
});

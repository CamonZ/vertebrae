import { create } from "zustand";
import type { Step } from "../bindings";

interface StepState {
  /** List of steps */
  steps: Step[];
}

interface StepActions {
  /** Set the full list of steps */
  setSteps: (steps: Step[]) => void;
  /** Insert or update a step in the list */
  upsertStep: (step: Step) => void;
  /** Remove a step by ID */
  removeStep: (stepId: string) => void;
}

export type StepStore = StepState & StepActions;

export const useStepStore = create<StepStore>((set) => ({
  steps: [],

  setSteps: (steps) => set({ steps }),

  upsertStep: (step) =>
    set((state) => {
      const index = state.steps.findIndex((s) => s.id === step.id);
      if (index >= 0) {
        const steps = [...state.steps];
        steps[index] = step;
        return { steps };
      }
      return { steps: [...state.steps, step] };
    }),

  removeStep: (stepId) =>
    set((state) => ({
      steps: state.steps.filter((s) => s.id !== stepId),
    })),
}));

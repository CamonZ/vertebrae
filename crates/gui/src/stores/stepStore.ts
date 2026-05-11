import { create } from "zustand";
import type { Step } from "../bindings";

interface StepState {
  /** List of steps */
  steps: Step[];
  /** Currently selected step ID */
  selectedStepId: string | null;
  /** Full details of the selected step */
  selectedStep: Step | null;
}

interface StepActions {
  /** Set the full list of steps */
  setSteps: (steps: Step[]) => void;
  /** Insert or update a step in the list */
  upsertStep: (step: Step) => void;
  /** Remove a step by ID */
  removeStep: (stepId: string) => void;
  /** Select a step by ID and optionally set its full details */
  selectStep: (id: string | null, step?: Step | null) => void;
  /** Clear the selected step */
  clearStepSelection: () => void;
  /** Reset all project-scoped step state */
  reset: () => void;
}

export type StepStore = StepState & StepActions;

const initialState: StepState = {
  steps: [],
  selectedStepId: null,
  selectedStep: null,
};

export const useStepStore = create<StepStore>((set) => ({
  ...initialState,

  setSteps: (steps) => set({ steps }),

  upsertStep: (step) =>
    set((state) => {
      const index = state.steps.findIndex((s) => s.id === step.id);
      if (index >= 0) {
        const steps = [...state.steps];
        steps[index] = step;
        return {
          steps,
          selectedStep:
            state.selectedStepId === step.id ? step : state.selectedStep,
        };
      }
      return {
        steps: [...state.steps, step],
        selectedStep:
          state.selectedStepId === step.id ? step : state.selectedStep,
      };
    }),

  removeStep: (stepId) =>
    set((state) => ({
      steps: state.steps.filter((s) => s.id !== stepId),
      ...(state.selectedStepId === stepId
        ? { selectedStepId: null, selectedStep: null }
        : {}),
    })),

  selectStep: (id, step) =>
    set({
      selectedStepId: id,
      selectedStep: step ?? null,
    }),

  clearStepSelection: () =>
    set({
      selectedStepId: null,
      selectedStep: null,
    }),

  reset: () => set(initialState),
}));

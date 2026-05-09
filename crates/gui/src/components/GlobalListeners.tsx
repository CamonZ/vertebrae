import {
  useTaskChangeListener,
  useTaskRunChangeListener,
  useWorkflowChangeListener,
  useStepChangeListener,
  useStepExecutionChangeListener,
  useSectionChangeListener,
  useSessionLogChangeListener,
  useStepTransitionChangeListener,
  useTaskStepChangeListener,
} from "../hooks";

/**
 * Invisible component that activates all Zustand store listeners at the app
 * root. Mounting once here guarantees every real-time event reaches the stores
 * regardless of which page is currently rendered.
 *
 * Individual pages may still call listeners with page-specific callbacks
 * (e.g. onCreated / onDeleted for local derived state), but the base
 * store-level subscription lives here.
 */
export function GlobalListeners() {
  useTaskChangeListener();
  useTaskRunChangeListener();
  useWorkflowChangeListener();
  useStepChangeListener();
  useStepExecutionChangeListener();
  useSectionChangeListener();
  useSessionLogChangeListener();
  useStepTransitionChangeListener();
  useTaskStepChangeListener();

  return null;
}

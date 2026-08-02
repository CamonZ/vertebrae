import {
  useTaskChangeListener,
  useArtifactChangeListener,
  useTaskRunChangeListener,
  useWorkflowChangeListener,
  useStepChangeListener,
  useStepExecutionChangeListener,
  useSectionChangeListener,
  useSessionLogChangeListener,
  useStepTransitionChangeListener,
  useWorkflowTransitionChangeListener,
} from "../hooks";
import { useLocalChatEventRouter } from "../hooks/useLocalChatEventRouter";

/**
 * Invisible component that activates app-level realtime listeners at the root.
 * Mounting once here guarantees every real-time event reaches the relevant
 * query cache or local store regardless of which page is currently rendered.
 *
 * Individual pages may still call listeners with page-specific callbacks
 * (e.g. onCreated / onDeleted for local derived state), but the base
 * subscription lives here.
 */
export function GlobalListeners() {
  useArtifactChangeListener();
  useTaskChangeListener();
  useTaskRunChangeListener();
  useWorkflowChangeListener();
  useStepChangeListener();
  useStepExecutionChangeListener();
  useSectionChangeListener();
  useSessionLogChangeListener();
  useStepTransitionChangeListener();
  useWorkflowTransitionChangeListener();
  useLocalChatEventRouter();

  return null;
}

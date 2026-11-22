import { ChatAttentionDrivers } from "./ChatAttentionDrivers";
import {
  useTaskChangeListener,
  useArtifactChangeListener,
  useDaemonChangeListener,
  useTaskRunChangeListener,
  useWorkflowChangeListener,
  useStepChangeListener,
  useStepExecutionChangeListener,
  useSectionChangeListener,
  useNotificationChangeListener,
  useSessionLogChangeListener,
  useStepTransitionChangeListener,
  useWorkflowTransitionChangeListener,
  usePipelineSummarySync,
} from "../hooks";
import { useGateChatSync } from "../hooks/useGateChatSync";
import { useTaskRunHistoryReconciliation } from "../hooks/useTaskRunHistoryReconciliation";
import { useLocalChatEventRouter } from "../hooks/useLocalChatEventRouter";
import { ChatAssociationDrivers } from "./ChatAssociationDrivers";
import { useChatCatalogSync } from "../hooks/useChatCatalogSync";

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
  useChatCatalogSync();
  useArtifactChangeListener();
  useDaemonChangeListener();
  useTaskChangeListener();
  useTaskRunChangeListener();
  useTaskRunHistoryReconciliation();
  useWorkflowChangeListener();
  useStepChangeListener();
  useStepExecutionChangeListener();
  useSectionChangeListener();
  useNotificationChangeListener();
  useSessionLogChangeListener();
  useStepTransitionChangeListener();
  useWorkflowTransitionChangeListener();
  usePipelineSummarySync();
  useLocalChatEventRouter();
  useGateChatSync();

  return (
    <>
      <ChatAssociationDrivers />
      <ChatAttentionDrivers />
    </>
  );
}

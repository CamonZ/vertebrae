import { useEffect, useRef } from "react";
import { useChatSession } from "../../hooks/useChatSession";
import { ChatHeader } from "./ChatHeader";
import { ChatMessages } from "./ChatMessages";
import { ChatComposer } from "./ChatComposer";
import { localChatSessionProjectDisplayName } from "../../utils/localChatSessionGroups";

interface ChatWindowProps {
  sessionId: string;
  /** Closes the whole chat panel (the header's ✕). Provided by the manager. */
  onClosePanel?: () => void;
  /** Starts a fresh local chat for the current project. */
  onStartFresh?: () => void;
  /** Opens/focuses the local chat history drawer. */
  onToggleHistory?: () => void;
  /** Expands/collapses the project chat panel session view. */
  onToggleWide?: () => void;
  isWide?: boolean;
  /** Adds another visible chat pane in the maximized view. */
  onSplitPane?: () => void;
  canSplitPane?: boolean;
  /** Collapses the maximized view back to this pane only. */
  onUnsplitPanes?: () => void;
  /** Closes this pane without closing the underlying chat session. */
  onClosePane?: () => void;
  /** Whether this pane should receive composer autofocus. */
  autoFocusComposer?: boolean;
  /** Label resolved from this session's captured project association. */
  projectLabel?: string;
}

/**
 * ChatWindow renders a single chat session: the header band (title + status),
 * the message thread, and the composer footer with its context-utilization bar.
 */
export function ChatWindow({
  sessionId,
  onClosePanel,
  onStartFresh,
  onToggleHistory,
  onToggleWide,
  isWide = false,
  onSplitPane,
  canSplitPane = true,
  onUnsplitPanes,
  onClosePane,
  autoFocusComposer = true,
  projectLabel,
}: ChatWindowProps) {
  const inputRef = useRef<HTMLTextAreaElement>(null);

  const chat = useChatSession(sessionId);

  // Focus the composer when this chat window is the foreground pane.
  useEffect(() => {
    if (!autoFocusComposer) return;
    inputRef.current?.focus();
  }, [autoFocusComposer]);

  if (!chat.session) return null;

  const isEmpty = chat.session.messages.length === 0;

  return (
    <div
      className="flex h-full min-h-0 flex-col"
      data-testid="local-chat-window"
      data-project-path={chat.session.projectPath ?? ""}
    >
      <ChatHeader
        label={chat.session.title?.trim() || chat.session.label}
        lifecycle={chat.lifecycle}
        isActive={chat.isActive}
        isClosing={chat.lifecycle === "closing"}
        canStopGeneration={chat.canStopGeneration}
        onClosePanel={onClosePanel}
        onStartFresh={onStartFresh}
        onToggleHistory={onToggleHistory}
        onToggleWide={onToggleWide}
        isWide={isWide}
        onSplitPane={onSplitPane}
        canSplitPane={canSplitPane}
        onUnsplitPanes={onUnsplitPanes}
        onClosePane={onClosePane}
        onClearMessages={() => void chat.handleClearMessages()}
        onStopGeneration={() => void chat.handleStopGeneration()}
        onTitleSave={chat.handleTitleSave}
        onTitleRegenerate={() => void chat.handleRegenerateTitle()}
        isTitleRegenerating={chat.isTitleRegenerating}
        titleError={chat.titleError}
        projectLabel={
          projectLabel ??
          localChatSessionProjectDisplayName(chat.session.projectPath)
        }
      />
      <ChatMessages
        sessionId={sessionId}
        projectPath={chat.session.projectPath}
        messages={chat.messages}
        assistantLabel={chat.assistantLabel}
        isEmpty={isEmpty}
        isActive={chat.isActive}
        isWaiting={chat.isWaiting}
        activityLabel={chat.activityLabel}
        compactionSummary={chat.compactionSummary}
        streamingAssistant={chat.streamingAssistant}
      />
      <ChatComposer
        session={chat.session}
        inputValue={chat.inputValue}
        setInputValue={chat.setInputValue}
        inputRef={inputRef}
        harnessCatalog={chat.harnessCatalog}
        visibleHarness={chat.visibleHarness}
        providerOptions={chat.providerOptions}
        supportedModelIds={chat.supportedModelIds}
        reasoningEfforts={chat.reasoningEfforts}
        supportedReasoningEffortIds={chat.supportedReasoningEffortIds}
        speedTiers={chat.speedTiers}
        supportedSpeedTierIds={chat.supportedSpeedTierIds}
        isBusy={chat.isBusy}
        isActive={chat.isActive}
        lockedHarness={chat.lockedHarness}
        hasResume={chat.hasResume}
        hasAvailableHarness={chat.hasAvailableHarness}
        canUseComposer={chat.canUseComposer}
        canSendMessage={chat.canSendMessage}
        shouldStartOrResume={chat.shouldStartOrResume}
        submitLabel={chat.submitLabel}
        composerPlaceholder={chat.composerPlaceholder}
        ctxPct={chat.ctxPct}
        ctxColor={chat.ctxColor}
        usage={chat.usage}
        threadTotalTokens={chat.threadTotalTokens}
        onSend={chat.handleSend}
        onStartSession={chat.handleStartSession}
        onHarnessChange={chat.handleHarnessChange}
        onModelChange={chat.handleModelChange}
        onReasoningEffortChange={chat.handleReasoningEffortChange}
        onSpeedTierChange={chat.handleSpeedTierChange}
        onPermissionModeChange={chat.handlePermissionModeChange}
      />
    </div>
  );
}

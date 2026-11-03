import { useChatStore } from "../../stores/chatStore";

/** A keyed slot subscribes only to its own text, independent of historical models. */
export function LiveAssistantText({
  sessionId,
  liveKey,
  fallback,
}: {
  sessionId: string;
  liveKey: string;
  fallback: string;
}) {
  const text = useChatStore(
    (state) =>
      state.sessions[sessionId]?.liveAssistantMessages?.[liveKey]?.text ??
      fallback
  );

  return <>{text}</>;
}

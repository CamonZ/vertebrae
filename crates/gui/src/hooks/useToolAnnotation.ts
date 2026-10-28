import type { LocalChatAnnotation } from "../bindings";
import { useChatStore } from "../stores/chatStore";

/** The latest Vertebrae annotation of `kind` for one tool call, if any. */
export function useToolAnnotation(
  sessionId: string | null | undefined,
  toolId: string | null | undefined,
  kind: string
): LocalChatAnnotation | null {
  return useChatStore((state) =>
    sessionId && toolId
      ? (state.sessions[sessionId]?.toolAnnotations?.[toolId]?.[kind] ?? null)
      : null
  );
}

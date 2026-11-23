import { useEffect } from "react";
import { listen } from "@tauri-apps/api/event";
import { commands, events } from "../bindings";
import { useChatStore } from "../stores/chatStore";
import {
  isCurrentProjectScopeGeneration,
  useProjectScopeGeneration,
} from "../stores/projectScopedStores";

interface CatalogEntryChanged {
  sessionId: string;
  session: unknown | null;
}

/**
 * Full recovery runs only on explicit fallback invalidation. Ordinary CDC
 * entries arrive already merged by the backend and are applied incrementally,
 * so they never trigger a full catalog read. Startup and reconnect send pending
 * writes through the mutation-only outbox.
 */
export function useChatCatalogSync() {
  const generation = useProjectScopeGeneration();

  useEffect(() => {
    let disposed = false;
    let running = false;
    let requested = false;

    const isCurrent = () =>
      !disposed && isCurrentProjectScopeGeneration(generation);

    const recover = async () => {
      if (!isCurrent()) {
        return;
      }

      requested = true;
      if (running) {
        return;
      }

      running = true;

      try {
        do {
          requested = false;
          await useChatStore.getState().refreshLocalSessionIndex(isCurrent);
        } while (requested && isCurrent());
      } catch {
        // Provider data and backend error bodies must never enter diagnostics.
        console.warn("[ChatCatalogSync] recovery_failed");
      } finally {
        running = false;
      }
    };

    const deliverOutbox = async () => {
      try {
        const result = await commands.deliverLocalChatCatalogOutbox();
        if (result.status !== "ok")
          console.warn("[ChatCatalogSync] outbox_delivery_failed");
      } catch {
        console.warn("[ChatCatalogSync] outbox_delivery_failed");
      }
    };

    const subscriptions = [
      listen<string>("websocket-state-changed", (event) => {
        if (event.payload === "connected" && isCurrent()) void deliverOutbox();
      }),
      listen<CatalogEntryChanged>("chat-catalog-entry-changed", (event) => {
        if (isCurrent()) {
          useChatStore
            .getState()
            .applyCatalogEntry(event.payload.sessionId, event.payload.session);
        }
      }),
      // Emitted only when a genuine entry could not be merged locally.
      listen("chat-catalog-changed", () => void recover()),
      events.reviewThreadCatalogRecoveryNeeded.listen(() => void recover()),
    ];

    void deliverOutbox();

    return () => {
      disposed = true;

      for (const subscription of subscriptions) {
        void subscription.then((unlisten) => unlisten());
      }
    };
  }, [generation]);
}

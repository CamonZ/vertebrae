import { useEffect } from "react";
import { listen } from "@tauri-apps/api/event";
import { events } from "../bindings";
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
 * Full recovery runs only on mount, reconnect and an explicit fallback
 * invalidation. Ordinary CDC entries arrive already merged by the backend and
 * are applied incrementally, so they never trigger a full catalog read.
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

    const subscriptions = [
      listen<string>("websocket-state-changed", (event) => {
        if (event.payload === "connected") {
          void recover();
        }
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

    void recover();

    return () => {
      disposed = true;

      for (const subscription of subscriptions) {
        void subscription.then((unlisten) => unlisten());
      }
    };
  }, [generation]);
}

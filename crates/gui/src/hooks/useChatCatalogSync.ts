import { useEffect } from "react";
import { listen } from "@tauri-apps/api/event";
import { useChatStore } from "../stores/chatStore";
import {
  isCurrentProjectScopeGeneration,
  useProjectScopeGeneration,
} from "../stores/projectScopedStores";

/** Recover missed catalog changes after reconnect and coalesce CDC bursts. */
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
      listen("chat-catalog-changed", () => void recover()),
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

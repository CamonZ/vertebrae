import { useState, useEffect } from "react";
import { listen } from "@tauri-apps/api/event";
import { commands } from "../bindings";

/** WebSocket connection states */
export type WebSocketStatus =
  | "disconnected"
  | "connecting"
  | "connected"
  | "reconnecting";

/**
 * Hook that listens to WebSocket connection state changes from the Tauri backend.
 * Fetches initial status on mount and updates on state change events.
 */
export function useWebSocketStatus(): WebSocketStatus {
  const [status, setStatus] = useState<WebSocketStatus>("disconnected");

  useEffect(() => {
    // Fetch initial status on mount
    commands.getWebsocketStatus().then((result) => {
      if (result.status === "ok") {
        const initialStatus = result.data as WebSocketStatus;
        console.debug(`[WebSocket] Initial status: ${initialStatus}`);
        setStatus(initialStatus);
      }
    });

    // Listen for websocket-state-changed events from the backend
    const unlistenPromise = listen<string>("websocket-state-changed", (event) => {
      const newStatus = event.payload as WebSocketStatus;
      console.debug(`[WebSocket] Status changed: ${newStatus}`);
      setStatus(newStatus);
    });

    // Cleanup on unmount
    return () => {
      unlistenPromise.then((unlisten) => unlisten());
    };
  }, []);

  return status;
}

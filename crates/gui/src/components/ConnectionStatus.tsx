import { useWebSocketStatus, type WebSocketStatus } from "../hooks/useWebSocketStatus";

/** Get display properties for each connection state */
function getStatusConfig(status: WebSocketStatus): {
  color: string;
  pulseColor: string;
  label: string;
  animate: boolean;
} {
  switch (status) {
    case "connected":
      return {
        color: "bg-green-500",
        pulseColor: "bg-green-400",
        label: "Connected",
        animate: false,
      };
    case "connecting":
      return {
        color: "bg-yellow-500",
        pulseColor: "bg-yellow-400",
        label: "Connecting",
        animate: true,
      };
    case "reconnecting":
      return {
        color: "bg-yellow-500",
        pulseColor: "bg-yellow-400",
        label: "Reconnecting",
        animate: true,
      };
    case "disconnected":
    default:
      return {
        color: "bg-red-500",
        pulseColor: "bg-red-400",
        label: "Disconnected",
        animate: false,
      };
  }
}

/**
 * Connection status indicator showing WebSocket connection state.
 * Displays a colored dot with optional pulse animation and tooltip.
 */
export function ConnectionStatus() {
  const status = useWebSocketStatus();
  const config = getStatusConfig(status);

  return (
    <div
      className="relative flex items-center gap-2"
      title={`WebSocket: ${config.label}`}
    >
      {/* Status dot with optional pulse animation */}
      <div className="relative">
        {config.animate && (
          <span
            className={`absolute inline-flex h-2.5 w-2.5 rounded-full ${config.pulseColor} animate-ping opacity-75`}
          />
        )}
        <span
          className={`relative inline-flex h-2.5 w-2.5 rounded-full ${config.color}`}
        />
      </div>
      {/* Status label - hidden on small screens */}
      <span className="hidden text-xs text-text-muted sm:inline">
        {config.label}
      </span>
    </div>
  );
}

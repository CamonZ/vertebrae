import { Tooltip } from "./atoms/Tooltip";
import { useWebSocketStatus, type WebSocketStatus } from "../hooks/useWebSocketStatus";

/**
 * Get display properties for each connection state.
 *
 * Colors are mapped to the Hearth design-system tokens (`--color-ok`/
 * `--color-warn`/`--color-err`) rather than raw Tailwind palette classes so the
 * dot stays in sync with the rest of the design shell. The pulse layer reuses
 * the same token as the solid dot, and `glow` applies the design's
 * `color-mix` glow (`.app-rail .sys .conn` in the design shell).
 */
function getStatusConfig(status: WebSocketStatus): {
  color: string;
  glow: string;
  label: string;
  animate: boolean;
} {
  switch (status) {
    case "connected":
      return {
        color: "bg-[var(--color-ok)]",
        glow: "shadow-[0_0_6px_color-mix(in_oklch,var(--color-ok)_60%,transparent)]",
        label: "Connected",
        animate: false,
      };
    case "connecting":
      return {
        color: "bg-[var(--color-warn)]",
        glow: "shadow-[0_0_6px_color-mix(in_oklch,var(--color-warn)_60%,transparent)]",
        label: "Connecting",
        animate: true,
      };
    case "reconnecting":
      return {
        color: "bg-[var(--color-warn)]",
        glow: "shadow-[0_0_6px_color-mix(in_oklch,var(--color-warn)_60%,transparent)]",
        label: "Reconnecting",
        animate: true,
      };
    case "disconnected":
    default:
      return {
        color: "bg-[var(--color-err)]",
        glow: "shadow-[0_0_6px_color-mix(in_oklch,var(--color-err)_60%,transparent)]",
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
    <Tooltip label={`WebSocket: ${config.label}`}>
      <div
        className="relative flex items-center"
        role="status"
        aria-label={`WebSocket: ${config.label}`}
      >
        <div className="relative">
          {config.animate && (
            <span
              className={`absolute inline-flex h-2.5 w-2.5 rounded-full ${config.color} animate-ping opacity-75`}
            />
          )}
          <span
            data-testid="connection-status-dot"
            className={`relative inline-flex h-2.5 w-2.5 rounded-full ${config.color} ${config.glow}`}
          />
        </div>
      </div>
    </Tooltip>
  );
}

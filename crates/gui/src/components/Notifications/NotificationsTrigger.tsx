import { Icon } from "../atoms";
import {
  getUnreadNotificationCount,
  useNotificationStore,
} from "../../stores";

/** Top-bar control for opening the session-only activity panel. */
export function NotificationsTrigger() {
  const isPanelOpen = useNotificationStore((state) => state.isPanelOpen);
  const notifications = useNotificationStore((state) => state.notifications);
  const togglePanel = useNotificationStore((state) => state.togglePanel);
  const unreadCount = getUnreadNotificationCount(notifications);
  const label =
    unreadCount > 0
      ? `Open notifications, ${unreadCount} unread`
      : "Open notifications";

  return (
    <button
      type="button"
      data-testid="notifications-trigger"
      aria-label={label}
      aria-expanded={isPanelOpen}
      onClick={togglePanel}
      className="inline-flex h-7 items-center gap-1.5 rounded-[var(--radius-sm)] border border-[var(--color-line-strong)] bg-[var(--color-bg-2)] px-2 font-mono text-2xs text-[var(--color-fg-soft)] transition-colors hover:border-[var(--color-accent)] hover:bg-[var(--color-bg-3)] hover:text-[var(--color-fg)] focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-accent)]"
    >
      <Icon size="sm" className="text-[var(--color-fg-mute)]">
        <path d="M18 8a6 6 0 0 0-12 0c0 7-3 7-3 9h18c0-2-3-2-3-9" />
        <path d="M10 21h4" />
      </Icon>
      {unreadCount > 0 && (
        <span data-testid="notifications-trigger-count">
          {unreadCount} new
        </span>
      )}
    </button>
  );
}

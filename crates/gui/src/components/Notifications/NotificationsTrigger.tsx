import { Icon } from "../atoms";
import { getUnreadNotificationCount, useNotificationStore } from "../../stores";

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
      className="inline-flex h-6 items-center gap-1.5 rounded-[var(--radius-xs)] border border-[var(--color-line-strong)] bg-[var(--color-bg-2)] px-2 font-mono text-2xs text-[var(--color-fg-soft)] transition-colors hover:border-[var(--color-accent)] hover:bg-[var(--color-bg-3)] hover:text-[var(--color-fg)] focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-accent)]"
    >
      <Icon
        size="xs"
        className="text-[var(--color-fg-mute)]"
        data-testid="notifications-trigger-icon"
      >
        <circle cx="12" cy="12" r="9" />
        <line x1="3" y1="12" x2="21" y2="12" />
        <path d="M12 3a13 13 0 0 1 3.5 9A13 13 0 0 1 12 21a13 13 0 0 1-3.5-9A13 13 0 0 1 12 3z" />
      </Icon>
      {unreadCount > 0 && (
        <span data-testid="notifications-trigger-count">{unreadCount} new</span>
      )}
    </button>
  );
}

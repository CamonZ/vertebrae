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
      title="Activity"
      className="ctl ctl-quiet notifications-trigger"
      data-unread={unreadCount > 0 || undefined}
    >
      <Icon size="xs" data-testid="notifications-trigger-icon">
        <path d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9" />
        <path d="M10.3 21a1.94 1.94 0 0 0 3.4 0" />
      </Icon>
      {unreadCount > 0 && (
        <span
          className="notifications-trigger-count"
          data-testid="notifications-trigger-count"
        >
          {unreadCount > 99 ? "99+" : unreadCount}
        </span>
      )}
    </button>
  );
}

import type { NotificationMessage, ToastType } from "../../types";
import { getUnreadNotificationCount, useNotificationStore } from "../../stores";
import { CloseIcon, FloatingDetailPanel, IconButton } from "../panels";
import { IdChip } from "../shared/HearthPrimitives";

const notificationTypeConfig: Record<
  ToastType,
  { icon: string; label: string; colorClass: string }
> = {
  success: {
    icon: "✓",
    label: "COMPLETED",
    colorClass: "text-emerald-400",
  },
  error: {
    icon: "×",
    label: "FAILED",
    colorClass: "text-red-400",
  },
  warning: {
    icon: "!",
    label: "WARNING",
    colorClass: "text-amber-400",
  },
  info: {
    icon: "◆",
    label: "UPDATED",
    colorClass: "text-[var(--color-accent)]",
  },
};

/**
 * The session-only activity surface. It intentionally reads directly from the
 * notification store: opening the panel never performs a query or restores
 * notifications from disk.
 */
export function NotificationsPanel() {
  const isPanelOpen = useNotificationStore((state) => state.isPanelOpen);
  const notifications = useNotificationStore((state) => state.notifications);
  const setPanelOpen = useNotificationStore((state) => state.setPanelOpen);
  const markAllRead = useNotificationStore((state) => state.markAllRead);
  const removeNotification = useNotificationStore(
    (state) => state.removeNotification
  );
  const unreadCount = getUnreadNotificationCount(notifications);
  const orderedNotifications = [...notifications].reverse();

  if (!isPanelOpen) return null;

  return (
    <FloatingDetailPanel
      panelId="notifications"
      widthStorageKey="notifications-panel-width"
      minWidth={360}
      maxWidth={560}
      defaultWidth={486}
      onClose={() => setPanelOpen(false)}
      isOpen={isPanelOpen}
      className="notifications-panel"
      testId="notifications-panel"
    >
      <div
        role="complementary"
        aria-label="Activity notifications"
        className="flex h-full min-h-0 flex-col"
        data-testid="notifications-panel-content"
      >
        <header className="flex shrink-0 items-center justify-between gap-3 border-b border-[var(--color-line)] px-4 py-4">
          <div className="flex min-w-0 items-baseline gap-2">
            <h2 className="font-serif text-xl italic leading-none text-[var(--color-fg)]">
              Activity
            </h2>
            <span
              className="font-mono text-2xs uppercase tracking-[0.12em] text-[var(--color-fg-mute)]"
              data-testid="notifications-unread-count"
            >
              {unreadCount} unread
            </span>
          </div>
          <div className="flex shrink-0 items-center gap-1">
            <button
              type="button"
              onClick={markAllRead}
              disabled={unreadCount === 0}
              className="rounded-[var(--radius-sm)] px-2 py-1 font-mono text-2xs uppercase tracking-[0.1em] text-[var(--color-fg-mute)] transition-colors hover:bg-[var(--color-bg-2)] hover:text-[var(--color-fg)] disabled:cursor-default disabled:opacity-50"
            >
              Mark all read
            </button>
            <IconButton
              onClick={() => setPanelOpen(false)}
              ariaLabel="Close notifications"
              testId="notifications-close"
            >
              <CloseIcon />
            </IconButton>
          </div>
        </header>

        <div
          className="min-h-0 flex-1 overflow-y-auto"
          data-testid="notification-list"
        >
          {orderedNotifications.length === 0 ? (
            <p className="px-4 py-10 text-center font-mono text-xs text-[var(--color-fg-mute)]">
              No activity yet.
            </p>
          ) : (
            <div role="list">
              {orderedNotifications.map((notification) => (
                <NotificationItem
                  key={notification.id}
                  notification={notification}
                  onDismiss={() => removeNotification(notification.id)}
                />
              ))}
            </div>
          )}
        </div>

        <footer className="flex shrink-0 items-center border-t border-[var(--color-line)] px-4 py-3 font-mono text-2xs uppercase tracking-[0.12em] text-[var(--color-fg-mute)]">
          {notifications.length}{" "}
          {notifications.length === 1 ? "notice" : "notices"}
        </footer>
      </div>
    </FloatingDetailPanel>
  );
}

interface NotificationItemProps {
  notification: NotificationMessage;
  onDismiss: () => void;
}

function NotificationItem({ notification, onDismiss }: NotificationItemProps) {
  const config = notificationTypeConfig[notification.type];

  return (
    <article
      role="listitem"
      data-testid={`notification-${notification.id}`}
      data-unread={notification.read ? undefined : "true"}
      className="group border-b border-[var(--color-line)] px-4 py-4 last:border-b-0"
    >
      <div className="flex items-start gap-3">
        <span
          aria-hidden="true"
          className={`mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-full border border-[var(--color-line-strong)] bg-[var(--color-bg-2)] font-mono text-xs ${config.colorClass}`}
        >
          {config.icon}
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            {!notification.read && (
              <span
                aria-label="Unread"
                className="h-1.5 w-1.5 shrink-0 rounded-full bg-[var(--color-accent)]"
              />
            )}
            <span
              className={`font-mono text-2xs uppercase tracking-[0.12em] ${config.colorClass}`}
            >
              {config.label}
            </span>
            <span className="font-mono text-2xs uppercase tracking-[0.1em] text-[var(--color-fg-mute)]">
              {notification.entity}
            </span>
            <span className="ml-auto shrink-0 font-mono text-2xs text-[var(--color-fg-mute)]">
              {formatNotificationAge(notification.timestamp)}
            </span>
          </div>
          <p className="mt-1 text-sm leading-5 text-[var(--color-fg-soft)]">
            {notification.message}
          </p>
          <div className="mt-2 flex items-center justify-between gap-2">
            <IdChip
              id={notification.entityId}
              kind={notification.entity}
              testId={`notification-id-${notification.id}`}
              className="min-w-0 max-w-full"
            />
            <button
              type="button"
              onClick={onDismiss}
              aria-label={`Dismiss ${notification.message}`}
              className="invisible rounded-[var(--radius-sm)] px-1.5 py-0.5 font-mono text-2xs uppercase tracking-[0.1em] text-[var(--color-fg-mute)] transition-colors hover:bg-[var(--color-bg-2)] hover:text-[var(--color-fg)] focus:visible:outline-none focus:visible:ring-1 focus:visible:ring-[var(--color-accent)] group-hover:visible"
            >
              Dismiss
            </button>
          </div>
        </div>
      </div>
    </article>
  );
}

/** Format a timestamp compactly for the activity list. */
export function formatNotificationAge(
  timestamp: number,
  now = Date.now()
): string {
  const seconds = Math.max(0, Math.floor((now - timestamp) / 1000));
  if (seconds < 60) return "now";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  return `${Math.floor(hours / 24)}d`;
}

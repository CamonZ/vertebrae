/**
 * Format ISO 8601 date as relative time or short date
 */
function formatRelativeTime(isoDate: string): string {
  const date = new Date(isoDate);
  const now = new Date();
  const diffMs = now.getTime() - date.getTime();
  const diffSecs = Math.floor(diffMs / 1000);
  const diffMins = Math.floor(diffSecs / 60);
  const diffHours = Math.floor(diffMins / 60);
  const diffDays = Math.floor(diffHours / 24);

  if (diffDays > 30) {
    // Show short date for older items
    return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
  } else if (diffDays > 0) {
    return `${diffDays}d ago`;
  } else if (diffHours > 0) {
    return `${diffHours}h ago`;
  } else if (diffMins > 0) {
    return `${diffMins}m ago`;
  } else {
    return 'just now';
  }
}

interface RelativeTimeProps {
  /** ISO 8601 date string */
  date: string;
  /** Additional CSS classes */
  className?: string;
}

/**
 * Displays a date as relative time (e.g., "2d ago", "3h ago")
 * Shows full timestamp on hover
 */
export function RelativeTime({ date, className = '' }: RelativeTimeProps) {
  const fullDate = new Date(date).toLocaleString();

  return (
    <span
      className={`text-xs text-text-muted ${className}`}
      title={fullDate}
    >
      {formatRelativeTime(date)}
    </span>
  );
}

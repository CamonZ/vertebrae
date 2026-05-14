const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

const MONTHS = [
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Oct",
  "Nov",
  "Dec",
];

function isSameLocalDay(a: Date, b: Date): boolean {
  return (
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate()
  );
}

/**
 * Format an ISO timestamp as a compact, human-friendly relative string.
 *
 *   < 60s          -> "Just now"
 *   < 60m          -> "Xm ago"
 *   same day       -> "Xh ago"
 *   previous day   -> "Yesterday"
 *   same year      -> "MMM D"
 *   otherwise      -> "MMM D, YYYY"
 *
 * Returns an empty string for unparseable / nullish input so call sites can
 * branch on truthiness without extra null checks.
 */
export function formatRelative(iso: string | null | undefined, now: Date = new Date()): string {
  if (!iso) return "";
  const then = new Date(iso);
  const t = then.getTime();
  if (Number.isNaN(t)) return "";

  const diffMs = now.getTime() - t;

  if (diffMs < MINUTE && diffMs > -MINUTE) {
    return "Just now";
  }

  if (diffMs < HOUR && diffMs >= 0) {
    const mins = Math.floor(diffMs / MINUTE);
    return `${mins}m ago`;
  }

  if (isSameLocalDay(then, now) && diffMs >= 0) {
    const hours = Math.floor(diffMs / HOUR);
    return `${hours}h ago`;
  }

  const yesterday = new Date(now);
  yesterday.setDate(now.getDate() - 1);
  if (isSameLocalDay(then, yesterday)) {
    return "Yesterday";
  }

  const month = MONTHS[then.getMonth()];
  const day = then.getDate();
  if (then.getFullYear() === now.getFullYear()) {
    return `${month} ${day}`;
  }
  return `${month} ${day}, ${then.getFullYear()}`;
}

import type { Daemon } from "../bindings";

export const DAEMON_STATUSES = [
  "active",
  "pending",
  "revoked",
  "removed",
] as const;

export type KnownDaemonStatus = (typeof DAEMON_STATUSES)[number];
export type DaemonStatusFilter = KnownDaemonStatus | "unknown" | "all";

export interface DaemonStatusCounts {
  all: number;
  active: number;
  pending: number;
  revoked: number;
  removed: number;
  unknown: number;
}

export interface DaemonGroup {
  status: DaemonStatusFilter;
  daemons: Daemon[];
}

const SEARCH_FIELDS = [
  "id",
  "name",
  "display_name",
  "host",
  "hostname",
  "os",
  "operating_system",
  "architecture",
  "arch",
  "harness",
  "harness_kind",
] as const;

const STATUS_ORDER: readonly DaemonStatusFilter[] = [
  "active",
  "pending",
  "unknown",
  "revoked",
  "removed",
];

function optionalSearchValue(daemon: Daemon, field: string): string | null {
  return daemonFieldValue(daemon, field);
}

export function daemonFieldValue(daemon: Daemon, field: string): string | null {
  const value = (daemon as unknown as Record<string, unknown>)[field];
  return typeof value === "string" || typeof value === "number"
    ? String(value)
    : null;
}

export function normalizedDaemonStatus(status: string): DaemonStatusFilter {
  const normalized = status.trim().toLowerCase();
  return DAEMON_STATUSES.includes(normalized as KnownDaemonStatus)
    ? (normalized as KnownDaemonStatus)
    : "unknown";
}

export function daemonStatusLabel(status: string | DaemonStatusFilter): string {
  const normalized = status === "all" ? "all" : normalizedDaemonStatus(status);
  if (normalized === "all") return "All";
  if (normalized === "unknown") return "Unknown";
  return normalized.charAt(0).toUpperCase() + normalized.slice(1);
}

export function daemonStatusIntent(
  status: string
): "success" | "warning" | "error" | "neutral" | "info" {
  switch (normalizedDaemonStatus(status)) {
    case "active":
      return "success";
    case "pending":
      return "warning";
    case "revoked":
      return "error";
    case "removed":
      return "neutral";
    case "unknown":
      return "info";
  }
  return "neutral";
}

export function daemonSearchText(daemon: Daemon): string {
  return SEARCH_FIELDS.map((field) => optionalSearchValue(daemon, field))
    .filter((value): value is string => value !== null)
    .join(" ")
    .toLocaleLowerCase();
}

export function filterDaemons(
  daemons: readonly Daemon[],
  search: string,
  status: DaemonStatusFilter
): Daemon[] {
  const normalizedSearch = search.trim().toLocaleLowerCase();
  return daemons.filter((daemon) => {
    const statusMatches =
      status === "all" || normalizedDaemonStatus(daemon.status) === status;
    const searchMatches =
      normalizedSearch.length === 0 ||
      daemonSearchText(daemon).includes(normalizedSearch);
    return statusMatches && searchMatches;
  });
}

export function countDaemonsByStatus(
  daemons: readonly Daemon[]
): DaemonStatusCounts {
  const counts: DaemonStatusCounts = {
    all: daemons.length,
    active: 0,
    pending: 0,
    revoked: 0,
    removed: 0,
    unknown: 0,
  };
  for (const daemon of daemons) {
    counts[normalizedDaemonStatus(daemon.status)] += 1;
  }
  return counts;
}

export function groupDaemonsByStatus(
  daemons: readonly Daemon[]
): DaemonGroup[] {
  return STATUS_ORDER.map((status) => ({
    status,
    daemons: daemons.filter(
      (daemon) => normalizedDaemonStatus(daemon.status) === status
    ),
  })).filter((group) => group.daemons.length > 0);
}

export function formatDaemonTimestamp(
  timestamp: string | null | undefined,
  fallback = "Unavailable"
): string {
  if (!timestamp) return fallback;
  const parsed = new Date(timestamp);
  if (Number.isNaN(parsed.getTime())) return "Unknown";
  return parsed.toLocaleString(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  });
}

export function formatDaemonHeartbeatAge(
  timestamp: string | null | undefined,
  now = Date.now()
): string {
  if (!timestamp) return "Unavailable";
  const parsed = Date.parse(timestamp);
  if (Number.isNaN(parsed)) return "Unknown";
  const seconds = Math.max(0, Math.floor((now - parsed) / 1000));
  if (seconds < 60) return seconds === 0 ? "Just now" : `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

/** Summarize only boolean capability entries supplied by Sacrum. */
export function formatDaemonCapabilityReadiness(capabilities: unknown): string {
  if (!capabilities || typeof capabilities !== "object") return "Unknown";

  const groups = ["providers", "harnesses"];
  const values = groups.flatMap((group) => {
    const entries = (capabilities as Record<string, unknown>)[group];
    if (!entries || typeof entries !== "object") return [];
    return Object.values(entries as Record<string, unknown>);
  });
  const known = values.filter(
    (value): value is boolean => typeof value === "boolean"
  );
  if (known.length === 0) return "Unknown";
  const ready = known.filter(Boolean).length;
  const unavailable = known.length - ready;
  return unavailable === 0
    ? `${ready}/${known.length} ready`
    : `${ready}/${known.length} ready (${unavailable} unavailable)`;
}

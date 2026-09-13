import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Daemon, DaemonBootstrap } from "../bindings";
import { Badge } from "../components/atoms/Badge";
import { Button } from "../components/atoms/Button";
import { Input } from "../components/atoms/Input";
import { EmptyState } from "../components/molecules/EmptyState";
import { Spinner } from "../components/Spinner";
import { DaemonInspector } from "../components/Daemons/DaemonInspector";
import { DaemonEnrollmentModal } from "../components/Daemons/DaemonEnrollmentModal";
import {
  countDaemonsByStatus,
  daemonFieldValue,
  daemonStatusIntent,
  daemonStatusLabel,
  filterDaemons,
  groupDaemonsByStatus,
  type DaemonStatusFilter,
} from "../daemons/filters";
import { useDaemonDetail } from "../hooks/useDaemonDetail";
import { useDaemonFleet } from "../hooks/useDaemonFleet";
import { useDaemonMutations } from "../hooks/useDaemonMutations";
import { useShellHeader } from "../hooks/useShellHeader";
import { useWebSocketStatus } from "../hooks/useWebSocketStatus";
import { usePanelExitTransition } from "../hooks/usePanelExitTransition";

const FILTER_ORDER: DaemonStatusFilter[] = [
  "active",
  "pending",
  "revoked",
  "removed",
];

function daemonLabel(daemon: Daemon): string {
  return daemon.display_name || daemon.name || daemon.id;
}

export function DaemonsPage() {
  const fleet = useDaemonFleet();
  const websocketStatus = useWebSocketStatus();
  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState<DaemonStatusFilter>("all");
  const [selectedDaemonId, setSelectedDaemonId] = useState<string | null>(null);
  const [enrollmentOpen, setEnrollmentOpen] = useState(false);
  const [enrollmentBootstrap, setEnrollmentBootstrap] =
    useState<DaemonBootstrap | null>(null);
  const [daemonAction, setDaemonAction] = useState<
    "reissue" | "unregister" | null
  >(null);
  const previousWebsocketStatus = useRef<string | null>(null);
  const previousConnectionId = useRef<string | null | undefined>(undefined);
  const rowRefs = useRef<Record<string, HTMLButtonElement | null>>({});

  const counts = useMemo(
    () => countDaemonsByStatus(fleet.daemons),
    [fleet.daemons]
  );
  const filteredDaemons = useMemo(
    () => filterDaemons(fleet.daemons, search, statusFilter),
    [fleet.daemons, search, statusFilter]
  );
  const groups = useMemo(
    () => groupDaemonsByStatus(filteredDaemons),
    [filteredDaemons]
  );
  const selectedFleetDaemon = useMemo(
    () =>
      fleet.daemons.find((daemon) => daemon.id === selectedDaemonId) ?? null,
    [fleet.daemons, selectedDaemonId]
  );
  const detail = useDaemonDetail(selectedDaemonId);
  const {
    rotateDaemonCredentials,
    unregisterDaemon,
    error: daemonActionError,
  } = useDaemonMutations();
  const { connectionId, refetch } = fleet;
  const selectedDetailDaemon =
    detail.connectionId !== connectionId ||
    (!fleet.isLoading && selectedDaemonId !== null && !selectedFleetDaemon)
      ? null
      : detail.isLoading
        ? selectedFleetDaemon
        : detail.data && selectedFleetDaemon
          ? {
              ...detail.data,
              status: selectedFleetDaemon.status,
              enrolled_at: selectedFleetDaemon.enrolled_at,
              removed_at: selectedFleetDaemon.removed_at,
              updated_at: selectedFleetDaemon.updated_at,
            }
          : detail.data;

  useEffect(() => {
    if (selectedDaemonId !== null && !fleet.isLoading && !selectedFleetDaemon) {
      setSelectedDaemonId(null);
    }
  }, [fleet.isLoading, selectedDaemonId, selectedFleetDaemon]);

  useEffect(() => {
    const previous = previousWebsocketStatus.current;
    previousWebsocketStatus.current = websocketStatus;
    if (
      previous !== null &&
      previous !== "connected" &&
      websocketStatus === "connected" &&
      connectionId
    ) {
      refetch();
    }
  }, [connectionId, refetch, websocketStatus]);

  useEffect(() => {
    const previous = previousConnectionId.current;
    previousConnectionId.current = connectionId;
    if (previous !== undefined && previous !== connectionId) {
      setSelectedDaemonId(null);
    }
  }, [connectionId]);

  const closeInspector = useCallback(() => {
    setSelectedDaemonId(null);
    if (document.activeElement instanceof HTMLElement) {
      document.activeElement.blur();
    }
  }, []);
  const handleReissue = useCallback(
    async (daemonId: string) => {
      setDaemonAction("reissue");
      try {
        const bootstrap = await rotateDaemonCredentials(daemonId);
        if (bootstrap) {
          setEnrollmentBootstrap(bootstrap);
          setEnrollmentOpen(true);
        }
      } finally {
        setDaemonAction(null);
      }
    },
    [rotateDaemonCredentials]
  );
  const handleUnregister = useCallback(
    async (daemonId: string) => {
      setDaemonAction("unregister");
      try {
        const removed = await unregisterDaemon(daemonId);
        if (removed) closeInspector();
      } finally {
        setDaemonAction(null);
      }
    },
    [closeInspector, unregisterDaemon]
  );
  const inspector = usePanelExitTransition(selectedDaemonId !== null, 180);

  const selectAdjacentDaemon = useCallback(
    (daemonId: string, direction: 1 | -1) => {
      const currentIndex = filteredDaemons.findIndex(
        (daemon) => daemon.id === daemonId
      );
      if (currentIndex < 0) return;
      const nextIndex = Math.max(
        0,
        Math.min(filteredDaemons.length - 1, currentIndex + direction)
      );
      const next = filteredDaemons[nextIndex];
      if (!next || next.id === daemonId) return;
      setSelectedDaemonId(next.id);
      window.requestAnimationFrame(() => rowRefs.current[next.id]?.focus());
    },
    [filteredDaemons]
  );

  useShellHeader(
    "Daemons",
    <span
      className="text-eyebrow text-[var(--color-fg-mute)]"
      data-testid="daemons-header-count"
    >
      <b className="font-semibold text-[var(--color-fg)]">{counts.all}</b>{" "}
      daemon{counts.all === 1 ? "" : "s"}
    </span>
  );

  return (
    <div
      className="daemons-page flex min-h-0 flex-1 bg-[var(--color-bg)]"
      data-testid="daemons-page"
    >
      <main className="flex min-w-0 flex-1 flex-col" aria-label="Daemon fleet">
        <h1 className="sr-only">Daemons</h1>
        <div className="flex shrink-0 flex-col gap-3 border-b border-[var(--color-line)] px-4 py-3">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div
              className="daemons-status-filters"
              role="group"
              aria-label="Filter daemons by status"
              data-testid="daemon-status-filters"
            >
              {FILTER_ORDER.map((status) => {
                const selected = statusFilter === status;
                return (
                  <button
                    key={status}
                    type="button"
                    className={["scope-chip", selected ? "active" : ""]
                      .filter(Boolean)
                      .join(" ")}
                    aria-pressed={selected}
                    data-testid={`daemon-status-filter-${status}`}
                    onClick={() =>
                      setStatusFilter((current) =>
                        current === status ? "all" : status
                      )
                    }
                  >
                    <span>{daemonStatusLabel(status)}</span>
                    <Badge
                      count={counts[status]}
                      intent={selected ? "accent" : "neutral"}
                    />
                  </button>
                );
              })}
            </div>
            <button
              type="button"
              className="daemon-register-button focus:outline-none focus:ring-2 focus:ring-accent/20"
              onClick={() => {
                setEnrollmentBootstrap(null);
                setEnrollmentOpen(true);
              }}
              data-testid="daemon-register"
            >
              + Register daemon
            </button>
          </div>
          <label className="block" htmlFor="daemon-search">
            <span className="sr-only">Search daemons</span>
            <Input
              id="daemon-search"
              type="search"
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              placeholder="Search name, ID, host, OS, architecture, or harness…"
              aria-label="Search daemons"
              data-testid="daemons-search"
            />
          </label>
          {(fleet.isRefreshing || fleet.error) && (
            <div className="flex items-center gap-2 text-xs text-[var(--color-fg-mute)]">
              {fleet.isRefreshing && (
                <span role="status" data-testid="daemon-fleet-refreshing">
                  Refreshing…
                </span>
              )}
              <Badge
                intent={fleet.error ? "warning" : "neutral"}
                testId="daemon-fleet-sync-state"
              >
                {fleet.error ? "Stale data" : "Fleet snapshot"}
              </Badge>
            </div>
          )}
        </div>

        <div
          className="min-h-0 flex-1 overflow-y-auto p-3"
          role="group"
          aria-label="Daemons"
          data-testid="daemon-fleet-list"
        >
          {fleet.isLoading && fleet.daemons.length === 0 ? (
            <div
              className="flex justify-center py-12"
              role="status"
              aria-label="Loading daemon fleet"
              data-testid="daemon-fleet-loading"
            >
              <Spinner />
            </div>
          ) : fleet.error && fleet.daemons.length === 0 ? (
            <div data-testid="daemon-fleet-error">
              <EmptyState
                title={
                  fleet.errorKind === "no_backend"
                    ? "Fleet unavailable"
                    : "Could not load daemon fleet"
                }
                description={fleet.error}
                action={
                  <Button
                    variant="secondary"
                    onClick={fleet.refetch}
                    data-testid="daemon-fleet-retry"
                  >
                    Retry
                  </Button>
                }
              />
            </div>
          ) : fleet.daemons.length === 0 ? (
            <div data-testid="daemon-fleet-empty">
              <EmptyState
                title="No daemons enrolled"
                description="This account does not have any daemon records yet."
              />
            </div>
          ) : (
            <>
              {fleet.error && (
                <div
                  className="mb-3 flex flex-wrap items-center justify-between gap-2 rounded-[var(--radius-md)] border border-[var(--color-warn)]/40 bg-[var(--color-warn-wash)] px-3 py-2 text-xs text-[var(--color-warn)]"
                  role="status"
                  data-testid="daemon-fleet-stale"
                >
                  <span>Showing the last known fleet data. {fleet.error}</span>
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={fleet.refetch}
                    data-testid="daemon-fleet-retry"
                  >
                    Retry
                  </Button>
                </div>
              )}
              {filteredDaemons.length === 0 ? (
                <div data-testid="daemon-fleet-no-matches">
                  <EmptyState
                    title="No matching daemons"
                    description="Try a different search or status filter."
                  />
                </div>
              ) : (
                groups.map((group) => (
                  <section
                    key={group.status}
                    className="mb-5 last:mb-0"
                    aria-labelledby={`daemon-group-${group.status}`}
                    data-testid={`daemon-group-${group.status}`}
                  >
                    <div className="mb-2 flex items-center gap-2 px-1">
                      <h2
                        id={`daemon-group-${group.status}`}
                        className="font-mono text-2xs uppercase tracking-[0.12em] text-[var(--color-fg-mute)]"
                      >
                        {daemonStatusLabel(group.status)}
                      </h2>
                      <span
                        className="font-mono text-2xs text-[var(--color-fg-faint)]"
                        data-testid={`daemon-group-count-${group.status}`}
                      >
                        {group.daemons.length}
                      </span>
                    </div>
                    <div className="space-y-1">
                      {group.daemons.map((daemon) => {
                        const label = daemonLabel(daemon);
                        const host = daemonFieldValue(daemon, "host");
                        const index = filteredDaemons.findIndex(
                          (item) => item.id === daemon.id
                        );
                        return (
                          <div
                            key={daemon.id}
                            data-testid={`daemon-row-container-${daemon.id}`}
                          >
                            <button
                              ref={(element) => {
                                rowRefs.current[daemon.id] = element;
                              }}
                              type="button"
                              className="flex w-full items-center gap-3 rounded-[var(--radius-md)] border border-transparent bg-[var(--color-bg-1)] px-3 py-2.5 text-left transition-colors hover:border-[var(--color-line-strong)] hover:bg-[var(--color-bg-2)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-accent)]"
                              aria-label={`${label}, ${daemonStatusLabel(daemon.status)}`}
                              aria-pressed={selectedDaemonId === daemon.id}
                              data-testid={`daemon-row-${daemon.id}`}
                              onClick={() => setSelectedDaemonId(daemon.id)}
                              onKeyDown={(event) => {
                                if (event.key === "ArrowDown") {
                                  event.preventDefault();
                                  selectAdjacentDaemon(daemon.id, 1);
                                } else if (event.key === "ArrowUp") {
                                  event.preventDefault();
                                  selectAdjacentDaemon(daemon.id, -1);
                                } else if (event.key === "Home") {
                                  event.preventDefault();
                                  const first = filteredDaemons[0];
                                  if (first) {
                                    setSelectedDaemonId(first.id);
                                    rowRefs.current[first.id]?.focus();
                                  }
                                } else if (event.key === "End") {
                                  event.preventDefault();
                                  const last =
                                    filteredDaemons[filteredDaemons.length - 1];
                                  if (last) {
                                    setSelectedDaemonId(last.id);
                                    rowRefs.current[last.id]?.focus();
                                  }
                                }
                              }}
                            >
                              <span className="min-w-0 flex-1">
                                <span className="block truncate text-sm text-[var(--color-fg)]">
                                  {label}
                                </span>
                                <span className="mt-1 flex flex-wrap gap-x-2 gap-y-1 font-mono text-2xs text-[var(--color-fg-mute)]">
                                  <span>{daemon.id}</span>
                                  {host && <span>{host}</span>}
                                  <span aria-hidden>·</span>
                                  <span>row {index + 1}</span>
                                </span>
                              </span>
                              <Badge
                                intent={daemonStatusIntent(daemon.status)}
                                dot
                                testId={`daemon-row-status-${daemon.id}`}
                              >
                                {daemonStatusLabel(daemon.status)}
                              </Badge>
                            </button>
                          </div>
                        );
                      })}
                    </div>
                  </section>
                ))
              )}
            </>
          )}
        </div>
      </main>

      {inspector.mounted && (
        <DaemonInspector
          daemon={selectedDetailDaemon}
          isLoading={detail.isLoading}
          error={detail.error}
          actionError={daemonActionError}
          isReissuing={daemonAction === "reissue"}
          isUnregistering={daemonAction === "unregister"}
          closing={inspector.closing}
          onClose={closeInspector}
          onReissue={handleReissue}
          onUnregister={handleUnregister}
          onExitAnimationEnd={inspector.onAnimationEnd}
        />
      )}
      <DaemonEnrollmentModal
        open={enrollmentOpen}
        initialBootstrap={enrollmentBootstrap}
        onClose={() => {
          setEnrollmentOpen(false);
          setEnrollmentBootstrap(null);
        }}
      />
    </div>
  );
}

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Daemon, DaemonBootstrap, DaemonNameUpdate } from "../bindings";
import { Badge } from "../components/atoms/Badge";
import { Button } from "../components/atoms/Button";
import { Input } from "../components/atoms/Input";
import { EmptyState } from "../components/molecules/EmptyState";
import { Spinner } from "../components/Spinner";
import { DaemonInspector } from "../components/Daemons/DaemonInspector";
import { DaemonEnrollmentModal } from "../components/Daemons/DaemonEnrollmentModal";
import {
  daemonFieldValue,
  daemonRequiresReenrollment,
  daemonStatusIntent,
  daemonStatusLabel,
  filterDaemons,
  formatDaemonCapabilityReadiness,
  formatDaemonHeartbeatAge,
  groupDaemonsByStatus,
} from "../daemons/filters";
import {
  useDaemonDetail,
  useDaemonEnrollmentMetadata,
} from "../hooks/useDaemonDetail";
import { useDaemonFleet } from "../hooks/useDaemonFleet";
import { useDaemonMutations } from "../hooks/useDaemonMutations";
import { useShellHeader } from "../hooks/useShellHeader";
import { useWebSocketStatus } from "../hooks/useWebSocketStatus";
import { usePanelExitTransition } from "../hooks/usePanelExitTransition";
import type { DaemonLifecycleAction } from "../components/Daemons/DaemonLifecycleStatus";
import { normalizedDaemonStatus } from "../daemons/filters";

/** Status groups that start collapsed: history rarely needs to be open. */
const INITIALLY_COLLAPSED = ["removed"];

const NOOP_RESET = () => {};

function daemonLabel(daemon: Daemon): string {
  return daemon.display_name || daemon.name || daemon.id;
}

export function DaemonsPage() {
  const fleet = useDaemonFleet();
  const websocketStatus = useWebSocketStatus();
  const [search, setSearch] = useState("");
  const [collapsedGroups, setCollapsedGroups] = useState<ReadonlySet<string>>(
    () => new Set(INITIALLY_COLLAPSED)
  );
  const [selectedDaemonId, setSelectedDaemonId] = useState<string | null>(null);
  const [enrollmentOpen, setEnrollmentOpen] = useState(false);
  const [enrollmentBootstrap, setEnrollmentBootstrap] =
    useState<DaemonBootstrap | null>(null);
  const [daemonAction, setDaemonAction] = useState<
    "rename" | "max_concurrency" | "reissue" | "unregister" | null
  >(null);
  const [lastLifecycleAction, setLastLifecycleAction] =
    useState<DaemonLifecycleAction | null>(null);
  const previousWebsocketStatus = useRef<string | null>(null);
  const previousConnectionId = useRef<string | null | undefined>(undefined);
  const rowRefs = useRef<Record<string, HTMLButtonElement | null>>({});

  const filteredDaemons = useMemo(
    () => filterDaemons(fleet.daemons, search, "all"),
    [fleet.daemons, search]
  );
  const groups = useMemo(
    () => groupDaemonsByStatus(filteredDaemons),
    [filteredDaemons]
  );
  // A search reveals matches even inside collapsed groups.
  const isGroupCollapsed = useCallback(
    (status: string) => !search.trim() && collapsedGroups.has(status),
    [collapsedGroups, search]
  );
  const visibleDaemons = useMemo(
    () =>
      groups.flatMap((group) =>
        isGroupCollapsed(group.status) ? [] : group.daemons
      ),
    [groups, isGroupCollapsed]
  );
  const toggleGroup = (status: string) =>
    setCollapsedGroups((current) => {
      const next = new Set(current);
      if (next.has(status)) next.delete(status);
      else next.add(status);
      return next;
    });
  const selectedFleetDaemon = useMemo(
    () =>
      fleet.daemons.find((daemon) => daemon.id === selectedDaemonId) ?? null,
    [fleet.daemons, selectedDaemonId]
  );
  const detail = useDaemonDetail(selectedDaemonId);
  const enrollment = useDaemonEnrollmentMetadata(selectedDaemonId);
  const {
    renameDaemon,
    setDaemonMaxConcurrency,
    clearDaemonMaxConcurrency,
    rotateDaemonCredentials,
    unregisterDaemon,
    isBusy: isDaemonMutationBusy,
    error: daemonActionError,
    errorKind: daemonActionErrorKind,
    reset: resetDaemonMutations = NOOP_RESET,
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

  useEffect(() => {
    setLastLifecycleAction(null);
    resetDaemonMutations();
  }, [resetDaemonMutations, selectedDaemonId]);

  const closeInspector = useCallback(() => {
    setSelectedDaemonId(null);
    setLastLifecycleAction(null);
    resetDaemonMutations();
    if (document.activeElement instanceof HTMLElement) {
      document.activeElement.blur();
    }
  }, [resetDaemonMutations]);
  const handleRename = useCallback(
    async (daemonId: string, name: DaemonNameUpdate): Promise<boolean> => {
      setLastLifecycleAction("rename");
      setDaemonAction("rename");
      try {
        return Boolean(await renameDaemon(daemonId, name));
      } finally {
        setDaemonAction(null);
      }
    },
    [renameDaemon]
  );
  const handleReissue = useCallback(
    async (daemonId: string) => {
      setLastLifecycleAction(null);
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
  const handleMaxConcurrencyChange = useCallback(
    async (daemonId: string, maxConcurrency: number | null): Promise<boolean> => {
      setDaemonAction("max_concurrency");
      try {
        const updated =
          maxConcurrency === null
            ? await clearDaemonMaxConcurrency(daemonId)
            : await setDaemonMaxConcurrency(daemonId, maxConcurrency);
        return Boolean(updated);
      } finally {
        setDaemonAction(null);
      }
    },
    [clearDaemonMaxConcurrency, setDaemonMaxConcurrency]
  );
  const handleUnregister = useCallback(
    async (daemonId: string): Promise<boolean> => {
      setLastLifecycleAction("unregister");
      setDaemonAction("unregister");
      try {
        const removed = await unregisterDaemon(daemonId);
        if (removed) closeInspector();
        return Boolean(removed);
      } finally {
        setDaemonAction(null);
      }
    },
    [closeInspector, unregisterDaemon]
  );
  const inspector = usePanelExitTransition(selectedDaemonId !== null, 180);

  const selectAdjacentDaemon = useCallback(
    (daemonId: string, direction: 1 | -1) => {
      const currentIndex = visibleDaemons.findIndex(
        (daemon) => daemon.id === daemonId
      );
      if (currentIndex < 0) return;
      const nextIndex = Math.max(
        0,
        Math.min(visibleDaemons.length - 1, currentIndex + direction)
      );
      const next = visibleDaemons[nextIndex];
      if (!next || next.id === daemonId) return;
      setSelectedDaemonId(next.id);
      window.requestAnimationFrame(() => rowRefs.current[next.id]?.focus());
    },
    [visibleDaemons]
  );

  useShellHeader("Daemons");


  return (
    <div
      className="daemons-page flex min-h-0 flex-1 bg-[var(--color-bg)]"
      data-testid="daemons-page"
    >
      <main className="flex min-w-0 flex-1 flex-col" aria-label="Daemon fleet">
        <h1 className="sr-only">Daemons</h1>
        <div className="daemons-toolbar">
          <div className="flex flex-wrap items-center gap-3">
            <label className="daemons-search" htmlFor="daemon-search">
              <span className="sr-only">Search daemons</span>
              <Input
                id="daemon-search"
                type="search"
                value={search}
                onChange={(event) => setSearch(event.target.value)}
                placeholder="Search name, host, OS or ID"
                aria-label="Search daemons"
                data-testid="daemons-search"
              />
            </label>
            <button
              type="button"
              className="ctl ctl-outline daemon-register"
              onClick={() => {
                setEnrollmentBootstrap(null);
                setEnrollmentOpen(true);
              }}
              data-testid="daemon-register"
            >
              <svg aria-hidden="true" viewBox="0 0 24 24" className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round">
                <path d="M12 5v14M5 12h14" />
              </svg>
              Register daemon
            </button>
          </div>
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
                <>
                <div className="daemon-list-head" aria-hidden>
                  <span>Daemon</span>
                  <span>Status</span>
                  <span>Capabilities</span>
                  <span>Concurrency</span>
                  <span className="daemon-col-seen">Last seen</span>
                </div>
                {groups.map((group) => (
                  <section
                    key={group.status}
                    className="mb-5 last:mb-0"
                    aria-labelledby={`daemon-group-${group.status}`}
                    data-testid={`daemon-group-${group.status}`}
                  >
                    <button
                      type="button"
                      className="daemon-group-head"
                      aria-expanded={!isGroupCollapsed(group.status)}
                      onClick={() => toggleGroup(group.status)}
                      data-testid={`daemon-group-toggle-${group.status}`}
                    >
                      <svg aria-hidden="true" viewBox="0 0 24 24" className="daemon-group-chev" fill="none" stroke="currentColor" strokeWidth={2.2} strokeLinecap="round" strokeLinejoin="round">
                        <path d="m9 6 6 6-6 6" />
                      </svg>
                      <h2 id={`daemon-group-${group.status}`}>
                        {daemonStatusLabel(group.status)}
                      </h2>
                      <span
                        className="daemon-group-count"
                        data-testid={`daemon-group-count-${group.status}`}
                      >
                        {group.daemons.length}
                      </span>
                    </button>
                    {!isGroupCollapsed(group.status) && (
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
                              className="daemon-row"
                              data-status={normalizedDaemonStatus(daemon.status)}
                              data-connection={daemon.connection_status ?? undefined}
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
                                  const first = visibleDaemons[0];
                                  if (first) {
                                    setSelectedDaemonId(first.id);
                                    rowRefs.current[first.id]?.focus();
                                  }
                                } else if (event.key === "End") {
                                  event.preventDefault();
                                  const last =
                                    visibleDaemons[visibleDaemons.length - 1];
                                  if (last) {
                                    setSelectedDaemonId(last.id);
                                    rowRefs.current[last.id]?.focus();
                                  }
                                }
                              }}
                            >
                              <span className="daemon-row-dot" aria-hidden />
                              <span className="daemon-row-body">
                                <span className="daemon-row-name">{label}</span>
                                <span className="daemon-row-meta">
                                  <span
                                    className="daemon-row-id"
                                    title={daemon.id}
                                    data-row-index={index + 1}
                                  >
                                    {daemon.id.slice(0, 8)}
                                  </span>
                                  {[
                                    host,
                                    [daemon.os, daemon.architecture]
                                      .filter(Boolean)
                                      .join(" · ") || null,
                                    daemon.daemon_version
                                      ? `v${daemon.daemon_version}`
                                      : null,
                                  ]
                                    .filter(Boolean)
                                    .map((part) => (
                                      <span key={part}>{part}</span>
                                    ))}
                                  {daemon.health_reason &&
                                    daemon.health !== "healthy" && (
                                      <span className="daemon-row-health">
                                        {daemon.health_reason}
                                      </span>
                                    )}
                                </span>
                              </span>
                              <span className="daemon-col-status">
                                <Badge
                                  intent={daemonStatusIntent(daemon.status)}
                                  dot
                                  testId={`daemon-row-status-${daemon.id}`}
                                >
                                  {daemonStatusLabel(daemon.status)}
                                </Badge>
                              </span>
                              <span className="daemon-col">
                                {formatDaemonCapabilityReadiness(
                                  daemon.capabilities
                                )}
                              </span>
                              <span className="daemon-col">
                                {daemon.max_concurrency == null
                                  ? "No limit"
                                  : `${daemon.max_concurrency} at once`}
                              </span>
                              <span className="daemon-col daemon-col-seen">
                                {daemon.last_seen_at
                                  ? formatDaemonHeartbeatAge(daemon.last_seen_at)
                                  : "—"}
                              </span>
                            </button>
                          </div>
                        );
                      })}
                    </div>
                    )}
                  </section>
                ))}
                </>
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
          errorKind={detail.errorKind}
          actionError={daemonActionError}
          actionErrorKind={daemonActionErrorKind}
          lifecycleAction={lastLifecycleAction}
          isBusy={isDaemonMutationBusy}
          isRenaming={daemonAction === "rename"}
          isUpdatingMaxConcurrency={daemonAction === "max_concurrency"}
          isReissuing={daemonAction === "reissue"}
          isUnregistering={daemonAction === "unregister"}
          reenrollmentRequired={
            enrollment.connectionId === connectionId &&
            daemonRequiresReenrollment(enrollment.data)
          }
          closing={inspector.closing}
          onClose={closeInspector}
          onRename={handleRename}
          onMaxConcurrencyChange={handleMaxConcurrencyChange}
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

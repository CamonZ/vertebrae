import {
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode,
} from "react";
import type { GithubPrCheck } from "../../../bindings";
import {
  isAbsoluteHttpUrl,
  openExternalUrl,
} from "../../../utils/openExternalUrl";
import { Button } from "../../atoms/Button";
import { Spinner } from "../../Spinner";
import { ExternalLinkGlyph } from "../GithubPr";
import {
  CloseGlyph,
  RefreshGlyph,
  RerunGlyph,
  StopGlyph,
} from "../githubActionGlyphs";
import { CheckGlyph } from "./CheckGlyph";
import { GithubFailureText } from "./PrFailure";
import {
  CHECK_STATUS_ORDER,
  OUTCOME_NOTE,
  checkDuration,
  formatAge,
  jobsInRun,
  formatCountdown,
  type PrCheckCounts,
  type PrCheckView,
  type PrChecksFreshness,
} from "./prChecksView";

/**
 * "2 failed · 1 running · 2 passed": zero buckets are hidden and the words
 * carry the meaning, so colour only reinforces it.
 */
export function CheckCounts({ counts }: { counts: PrCheckCounts }) {
  const buckets = CHECK_STATUS_ORDER.filter((status) => counts[status] > 0);
  if (buckets.length === 0)
    return <span className="pr-check-counts pr-assoc-mute">No checks</span>;
  return (
    <span className="pr-check-counts">
      {buckets.map((status) => (
        <span key={status} className={`pr-check-count is-${status}`}>
          <CheckGlyph status={status} />
          <span className="pr-check-count-n">{counts[status]}</span>
          <span className="pr-check-count-word">
            {status === "passed" && counts.passed === counts.total
              ? "passed · all checks"
              : status}
          </span>
        </span>
      ))}
    </span>
  );
}

/**
 * When the checks were fetched. The routine "Updated …" line is marked so a
 * narrow bar can hide it; refreshing, stale and failed notices always show,
 * and a failed refresh keeps saying how old the shown state is.
 */
export function ChecksRefreshLine({
  freshness,
  now,
  onRefresh,
}: {
  freshness: PrChecksFreshness;
  now: number;
  onRefresh: () => void;
}) {
  const refreshButton = (label: string) => (
    <Button
      variant="ghost"
      size="sm"
      iconLeft={<RefreshGlyph />}
      onClick={onRefresh}
    >
      {label}
    </Button>
  );
  switch (freshness.kind) {
    case "loading":
      return (
        <span className="pr-checks-refresh pr-assoc-mute" role="status">
          <Spinner className="h-3 w-3" /> Loading checks…
        </span>
      );
    case "fresh":
      return (
        <span className="pr-checks-refresh pr-assoc-mute is-routine">
          Updated {formatAge(freshness.fetchedAt, now)}
        </span>
      );
    case "refreshing":
      return (
        <span className="pr-checks-refresh pr-assoc-mute" role="status">
          <Spinner className="h-3 w-3" /> Refreshing from GitHub…
        </span>
      );
    case "awaiting_push":
      return (
        <span className="pr-checks-refresh pr-assoc-mute" role="status">
          Waiting for GitHub to pick up{" "}
          <code className="pr-checks-sha">{freshness.head.slice(0, 7)}</code>
          {refreshButton("Refresh")}
        </span>
      );
    case "stale":
      return (
        <span className="pr-checks-refresh pr-assoc-warn" role="status">
          Stale · updated {formatAge(freshness.fetchedAt, now)}
          {refreshButton("Refresh")}
        </span>
      );
    case "failed":
      return (
        <span className="pr-checks-refresh pr-assoc-err">
          {/* Only the reason is announced; the ages below tick every second. */}
          <span title={freshness.failure.message}>
            <span role="alert">
              Couldn’t refresh:{" "}
              <GithubFailureText failure={freshness.failure} />.
            </span>
            {freshness.fetchedAt !== null &&
              ` Showing last known state from ${formatAge(freshness.fetchedAt, now)}.`}
          </span>
          {refreshButton("Retry now")}
          {freshness.retryAt !== null && (
            <span className="pr-assoc-mute">
              auto in {formatCountdown(freshness.retryAt, now)}
            </span>
          )}
        </span>
      );
    default: {
      const unreachable: never = freshness;
      return unreachable;
    }
  }
}

function statusText(view: PrCheckView, now: number): string {
  const duration = checkDuration(view.check, now);
  if (view.cancel?.status === "requested") return "cancelling";
  if (view.status === "queued")
    return view.rerun?.status === "requested" ? "re-run queued" : "queued";
  if (view.status === "running")
    return duration ? `running · ${duration}` : "running";
  const note = view.check.outcome ? OUTCOME_NOTE[view.check.outcome] : null;
  return [note, duration].filter(Boolean).join(" · ");
}

/**
 * A check row's icon action: 24×24 with a hover wash, named by its label
 * and tooltip. While `busy` it shows a spinner and ignores clicks.
 */
function CheckIconButton({
  label,
  title = label,
  busy = false,
  autoFocus,
  onClick,
  onKeyDown,
  children,
}: {
  label: string;
  title?: string;
  busy?: boolean;
  autoFocus?: boolean;
  onClick: () => void;
  onKeyDown?: (event: KeyboardEvent<HTMLButtonElement>) => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      className="pr-check-icon"
      aria-label={label}
      title={title}
      aria-disabled={busy || undefined}
      aria-busy={busy || undefined}
      autoFocus={autoFocus}
      onKeyDown={onKeyDown}
      onClick={() => {
        if (!busy) onClick();
      }}
    >
      {busy ? <Spinner className="h-3 w-3" /> : children}
    </button>
  );
}

/** Re-run for a failed check: an Actions job here, other providers say where. */
function RerunControl({
  view,
  onRerun,
}: {
  view: PrCheckView;
  onRerun: (checkId: string) => void;
}) {
  const { check, rerun, status } = view;
  if (status !== "failed") return null;
  switch (check.rerun) {
    case "allowed": {
      const requesting = rerun?.status === "requesting";
      return (
        <CheckIconButton
          label={`Re-run ${check.name} on GitHub Actions`}
          title={requesting ? "Requesting re-run…" : "Re-run job on GitHub"}
          busy={requesting}
          onClick={() => onRerun(check.id)}
        >
          <RerunGlyph />
        </CheckIconButton>
      );
    }
    case "provider":
      // The row's open link goes to the provider, where it re-runs.
      return <span className="pr-assoc-mute">Re-runs on {check.provider}</span>;
    case "no_permission":
      return (
        <span
          className="pr-assoc-mute"
          title="Re-running jobs needs write access to the repository"
        >
          No re-run access
        </span>
      );
    case "run_in_progress":
      return (
        <span
          className="pr-assoc-mute"
          title="GitHub re-runs a job only once the rest of its workflow run has finished"
        >
          Re-run after the run finishes
        </span>
      );
    case "pull_request_closed":
    case "not_applicable":
      return null;
    default: {
      const unreachable: never = check.rerun;
      return unreachable;
    }
  }
}

/**
 * Cancel acts on the whole workflow run (GitHub has no per-job cancel), so
 * it asks first and says how many jobs stop with it. Escape steps back out
 * of the question without closing the drawer.
 */
function CancelControl({
  view,
  jobs,
  confirming,
  onConfirming,
  onCancel,
}: {
  view: PrCheckView;
  jobs: number;
  confirming: boolean;
  onConfirming: (confirming: boolean) => void;
  onCancel: (checkId: string) => void;
}) {
  const { check, cancel, status } = view;
  if (status !== "running" && status !== "queued") return null;
  if (cancel?.status === "requested") return null;
  switch (check.cancel) {
    case "allowed": {
      const requesting = cancel?.status === "requesting";
      if (confirming && !requesting) {
        const keepOnEscape = (event: KeyboardEvent<HTMLElement>) => {
          if (event.key !== "Escape" || event.nativeEvent.isComposing) return;
          event.preventDefault();
          event.stopPropagation();
          onConfirming(false);
        };
        return (
          <span
            className="pr-check-confirm"
            role="group"
            aria-label={`Cancel the workflow run of ${check.name}?`}
            onKeyDown={keepOnEscape}
          >
            <span className="pr-assoc-mute">
              Stop {jobs === 1 ? "this job" : `all ${jobs} jobs`} in the run?
            </span>
            <CheckIconButton
              label={`Confirm: cancel the workflow run of ${check.name} on GitHub Actions`}
              title="Cancel run on GitHub"
              autoFocus
              onClick={() => {
                onConfirming(false);
                onCancel(check.id);
              }}
            >
              <StopGlyph />
            </CheckIconButton>
            <CheckIconButton
              label="Keep running"
              onClick={() => onConfirming(false)}
            >
              <CloseGlyph />
            </CheckIconButton>
          </span>
        );
      }
      return (
        <CheckIconButton
          label={`Cancel the workflow run of ${check.name}`}
          title={requesting ? "Cancelling run…" : "Cancel run…"}
          busy={requesting}
          onClick={() => onConfirming(true)}
        >
          <StopGlyph />
        </CheckIconButton>
      );
    }
    case "no_permission":
      return (
        <span
          className="pr-assoc-mute"
          title="Cancelling runs needs write access to the repository"
        >
          No cancel access
        </span>
      );
    case "provider":
    case "not_applicable":
      return null;
    default: {
      const unreachable: never = check.cancel;
      return unreachable;
    }
  }
}

function CheckDetail({ check }: { check: GithubPrCheck }) {
  if (!check.failedStep && !check.summary) return null;
  return (
    <div className="pr-check-detail">
      {check.failedStep && (
        <div>
          Failed step <code>{check.failedStep}</code>
        </div>
      )}
      {check.summary && <div>{check.summary}</div>}
    </div>
  );
}

/**
 * Re-run and cancel swap or remove the focused control (Keep running, the
 * confirm step, a finished request). When that drops focus to the page, put
 * it back on the row's first action, or the row itself, so keyboard users
 * keep their place.
 */
function useKeepFocusInRow() {
  const rowRef = useRef<HTMLLIElement>(null);
  const holdsFocus = useRef(false);
  useLayoutEffect(() => {
    const row = rowRef.current;
    if (!row) return;
    const onFocusIn = () => {
      holdsFocus.current = true;
    };
    const onFocusOut = (event: FocusEvent) => {
      const from = event.target as Element;
      const to = event.relatedTarget as Node | null;
      if (to && row.contains(to)) return;
      // A removed control blurs while leaving the DOM; anything else is
      // the user moving away.
      queueMicrotask(() => {
        if (from.isConnected) holdsFocus.current = false;
      });
    };
    row.addEventListener("focusin", onFocusIn);
    row.addEventListener("focusout", onFocusOut);
    return () => {
      row.removeEventListener("focusin", onFocusIn);
      row.removeEventListener("focusout", onFocusOut);
    };
  }, []);
  useLayoutEffect(() => {
    const row = rowRef.current;
    if (!row || !holdsFocus.current) return;
    const active = document.activeElement;
    if (active && active !== document.body) {
      if (!row.contains(active)) holdsFocus.current = false;
      return;
    }
    (row.querySelector<HTMLElement>(".pr-check-actions button") ?? row).focus();
  });
  return rowRef;
}

function CheckRow({
  view,
  expanded,
  onToggle,
  onRerun,
  onCancel,
  runJobs,
  now,
}: {
  view: PrCheckView;
  expanded: boolean;
  onToggle: () => void;
  onRerun: (checkId: string) => void;
  onCancel: (checkId: string) => void;
  runJobs: number;
  now: number;
}) {
  const { check, status, rerun, cancel } = view;
  const [confirming, setConfirming] = useState(false);
  const expandable = Boolean(check.failedStep || check.summary);
  const detailId = useId();
  const canOpen = isAbsoluteHttpUrl(check.url);
  const host = check.actionsJob ? "GitHub" : check.provider;
  const rowRef = useKeepFocusInRow();
  return (
    <li
      ref={rowRef}
      className={`pr-check is-${status}`}
      data-testid="pr-check-row"
      tabIndex={-1}
    >
      <div className="pr-check-row">
        <button
          type="button"
          className="pr-check-toggle"
          aria-expanded={expandable ? expanded : undefined}
          aria-controls={expandable && expanded ? detailId : undefined}
          disabled={!expandable}
          onClick={onToggle}
        >
          <CheckGlyph status={status} />
          <span className="sr-only">{status}: </span>
          <span className="pr-check-name" title={check.name}>
            {check.name}
          </span>
          <span className="pr-check-meta">{statusText(view, now)}</span>
        </button>
        <span className="pr-check-actions">
          <RerunControl view={view} onRerun={onRerun} />
          <CancelControl
            view={view}
            jobs={runJobs}
            confirming={confirming}
            onConfirming={setConfirming}
            onCancel={onCancel}
          />
          {canOpen && (
            <CheckIconButton
              label={`Open ${check.name} on ${host}`}
              title={`Open on ${host}`}
              onClick={() => openExternalUrl(check.url as string)}
            >
              <ExternalLinkGlyph />
            </CheckIconButton>
          )}
        </span>
      </div>
      {rerun?.status === "failed" && (
        <p className="pr-check-rerun-error pr-assoc-err" role="alert">
          Re-run request failed: {rerun.message}. Checks were refreshed; Re-run
          job is safe to try again if it is still failed.
        </p>
      )}
      {cancel?.status === "failed" && (
        <p className="pr-check-rerun-error pr-assoc-err" role="alert">
          Cancel request failed: {cancel.message}. Checks were refreshed; try
          again if the run is still going.
        </p>
      )}
      {expandable && expanded && (
        <div id={detailId}>
          <CheckDetail check={check} />
        </div>
      )}
    </li>
  );
}

/**
 * The linked PR's checks, one row each; the first failure with detail
 * starts open. `dense` is the Review rail's narrower list.
 */
export function PrChecksList({
  prNumber,
  checks,
  truncated,
  now,
  onRerun,
  onCancel,
  dense = false,
}: {
  prNumber: number;
  checks: readonly PrCheckView[];
  truncated: boolean;
  now: number;
  onRerun: (checkId: string) => void;
  onCancel: (checkId: string) => void;
  dense?: boolean;
}) {
  // The first failure with detail starts open; the user's choice then sticks.
  const [open, setOpen] = useState<string | null | undefined>(undefined);
  const firstFailed = checks.find(
    (view) =>
      view.status === "failed" &&
      Boolean(view.check.failedStep || view.check.summary)
  );
  const expandedId =
    open === undefined ? (firstFailed?.check.id ?? null) : open;

  return (
    <>
      {checks.length === 0 ? (
        <p className="pr-assoc-mute">
          GitHub reports no checks for PR #{prNumber}.
        </p>
      ) : (
        <ul
          className={`pr-checks-list${dense ? " is-dense" : ""}`}
          aria-label={`Checks on PR #${prNumber}`}
        >
          {checks.map((view) => (
            <CheckRow
              key={view.check.id}
              view={view}
              now={now}
              expanded={expandedId === view.check.id}
              onToggle={() =>
                setOpen(expandedId === view.check.id ? null : view.check.id)
              }
              onRerun={onRerun}
              onCancel={onCancel}
              runJobs={jobsInRun(checks, view.check.actionsRun)}
            />
          ))}
        </ul>
      )}
      {truncated && (
        <p className="pr-assoc-mute">
          Showing the first 100 checks; open the PR on GitHub for the rest.
        </p>
      )}
    </>
  );
}

/**
 * Band 3 under the review bar. It skips its own counts header because the
 * bar already shows the same counts.
 */
export function PrChecksDrawer({
  id,
  ...list
}: { id: string } & Omit<Parameters<typeof PrChecksList>[0], "dense">) {
  return (
    <div id={id} className="pr-checks-drawer" data-testid="pr-checks-drawer">
      <PrChecksList {...list} />
    </div>
  );
}

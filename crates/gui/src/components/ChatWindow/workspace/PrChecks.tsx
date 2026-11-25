import { useState } from "react";
import type { GithubFailure, GithubPrCheck } from "../../../bindings";
import {
  isAbsoluteHttpUrl,
  openExternalUrl,
} from "../../../utils/openExternalUrl";
import { Button } from "../../atoms/Button";
import { Spinner } from "../../Spinner";
import { ExternalLinkGlyph, GitHubGlyph } from "../GithubPr";
import { RefreshGlyph, RerunGlyph, StopGlyph } from "../githubActionGlyphs";
import { CheckGlyph } from "./CheckGlyph";
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

function failureReason(failure: GithubFailure): string {
  switch (failure.kind) {
    case "rate_limited":
      return "GitHub rate limit reached";
    case "gh_missing":
      return "GitHub CLI (gh) not found";
    case "auth_expired":
      return "gh sign-in expired · run gh auth login";
    case "not_found":
    case "other":
      return failure.message;
    default: {
      const unreachable: never = failure.kind;
      return unreachable;
    }
  }
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
        <span className="pr-checks-refresh pr-assoc-err" role="alert">
          <span title={freshness.failure.message}>
            Couldn’t refresh: {failureReason(freshness.failure)}.
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
        <Button
          variant="secondary"
          size="sm"
          iconLeft={
            requesting ? <Spinner className="h-3 w-3" /> : <RerunGlyph />
          }
          iconRight={<GitHubGlyph size="xs" />}
          aria-disabled={requesting || undefined}
          aria-busy={requesting || undefined}
          aria-label={`Re-run ${check.name} on GitHub Actions`}
          onClick={() => {
            if (!requesting) onRerun(check.id);
          }}
        >
          {requesting ? "Requesting…" : "Re-run job"}
        </Button>
      );
    }
    case "provider":
      return isAbsoluteHttpUrl(check.url) ? (
        <Button
          variant="ghost"
          size="sm"
          iconRight={<ExternalLinkGlyph />}
          aria-label={`Re-run ${check.name} on ${check.provider}`}
          title={`${check.provider} checks re-run from ${check.provider}`}
          onClick={() => openExternalUrl(check.url as string)}
        >
          Re-run on {check.provider}
        </Button>
      ) : (
        <span className="pr-assoc-mute">Re-runs on {check.provider}</span>
      );
    case "no_permission":
      return (
        <span
          className="pr-assoc-mute"
          title="Re-running jobs needs write access to the repository"
        >
          No re-run access
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
 * it asks first and says how many jobs stop with it.
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
      if (confirming && !requesting)
        return (
          <span className="pr-check-confirm" role="group">
            <span className="pr-assoc-mute">
              Stops {jobs === 1 ? "this job" : `all ${jobs} jobs`} in the run
            </span>
            <Button
              variant="secondary"
              size="sm"
              iconLeft={<StopGlyph />}
              iconRight={<GitHubGlyph size="xs" />}
              autoFocus
              aria-label={`Confirm: cancel the workflow run of ${check.name} on GitHub Actions`}
              onClick={() => {
                onConfirming(false);
                onCancel(check.id);
              }}
            >
              Cancel run
            </Button>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => onConfirming(false)}
            >
              Keep running
            </Button>
          </span>
        );
      return (
        <Button
          variant="ghost"
          size="sm"
          iconLeft={
            requesting ? <Spinner className="h-3 w-3" /> : <StopGlyph />
          }
          aria-disabled={requesting || undefined}
          aria-busy={requesting || undefined}
          aria-label={`Cancel the workflow run of ${check.name}`}
          onClick={() => {
            if (!requesting) onConfirming(true);
          }}
        >
          {requesting ? "Cancelling…" : "Cancel run…"}
        </Button>
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
  const detailId = `pr-check-detail-${check.id}`;
  const canOpen = isAbsoluteHttpUrl(check.url);
  const host = check.actionsJob ? "GitHub" : check.provider;
  return (
    <li className={`pr-check is-${status}`} data-testid="pr-check-row">
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
            <button
              type="button"
              className="pr-check-open"
              aria-label={`Open ${check.name} on ${host}`}
              title={`Open on ${host}`}
              onClick={() => openExternalUrl(check.url as string)}
            >
              <ExternalLinkGlyph />
            </button>
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
 * Band 3 under the review bar. It skips its own counts header because the
 * bar already shows the same counts.
 */
export function PrChecksDrawer({
  id,
  prNumber,
  checks,
  truncated,
  now,
  onRerun,
  onCancel,
}: {
  id: string;
  prNumber: number;
  checks: readonly PrCheckView[];
  truncated: boolean;
  now: number;
  onRerun: (checkId: string) => void;
  onCancel: (checkId: string) => void;
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
    <div id={id} className="pr-checks-drawer" data-testid="pr-checks-drawer">
      {checks.length === 0 ? (
        <p className="pr-assoc-mute">
          GitHub reports no checks for PR #{prNumber}.
        </p>
      ) : (
        <ul className="pr-checks-list" aria-label={`Checks on PR #${prNumber}`}>
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
    </div>
  );
}

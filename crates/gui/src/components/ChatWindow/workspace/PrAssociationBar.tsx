import {
  useId,
  useImperativeHandle,
  useLayoutEffect,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode,
  type Ref,
} from "react";
import type { GithubPullRequest } from "../../../bindings";
import {
  useChecksFreshness,
  type WorktreePr,
} from "../../../hooks/useWorktreePr";
import {
  needsUserFix,
  type WorktreePrAssociation,
} from "../../../stores/worktreePrStore";
import {
  isAbsoluteHttpUrl,
  openExternalUrl,
} from "../../../utils/openExternalUrl";
import { Button } from "../../atoms/Button";
import { Icon } from "../../atoms/Icon";
import { OverflowMenu } from "../../molecules/OverflowMenu";
import { Spinner } from "../../Spinner";
import {
  ExternalLinkGlyph,
  GitHubGlyph,
  PrNumber,
  PrStateBadge,
} from "../GithubPr";
import {
  LinkGlyph,
  NewPrGlyph,
  RefreshGlyph,
  UnlinkGlyph,
} from "../githubActionGlyphs";
import { ManualPrLink } from "./ManualPrLink";
import { PrCandidateList } from "./PrCandidateList";
import { CheckCounts, ChecksRefreshLine, PrChecksDrawer } from "./PrChecks";
import { checkCountsLabel } from "./prChecksView";
import { AuthExpiredText, GhMissingText, GithubFailureText } from "./PrFailure";
import "./prAssociation.css";

const FOCUS_TARGET = "data-pr-focus";
const focusTarget = { [FOCUS_TARGET]: "" };

function prRepo(pr: GithubPullRequest): string {
  return `${pr.owner}/${pr.repo}`;
}

type Linked = Extract<WorktreePrAssociation, { status: "linked" }>;
type NoPr = Extract<WorktreePrAssociation, { status: "none" }>;
type Ambiguous = Extract<WorktreePrAssociation, { status: "ambiguous" }>;

/** The bar's one open panel: the checks drawer or the manual link. */
type Panel = "checks" | "link" | null;

interface BarActions {
  busy: boolean;
  refreshing: boolean;
  refresh: () => void;
  link: (prNumber: number, repo: string | null) => Promise<boolean>;
  unlink: () => void;
}

const TONE_CLASS = {
  mute: "pr-assoc-mute",
  error: "pr-assoc-err",
  plain: undefined,
} as const;

function PrStatusRow({
  tone = "mute",
  icon = <GitHubGlyph />,
  action,
  children,
}: {
  tone?: keyof typeof TONE_CLASS;
  icon?: ReactNode;
  action?: ReactNode;
  children: ReactNode;
}) {
  return (
    <div className="pr-assoc-row" role="status">
      {icon}
      <span className={TONE_CLASS[tone]}>{children}</span>
      {action && <span className="pr-assoc-actions">{action}</span>}
    </div>
  );
}

function CheckAgainButton({ busy, refreshing: checking, refresh }: BarActions) {
  return (
    <Button
      variant="secondary"
      size="sm"
      {...focusTarget}
      // aria-disabled keeps focus on the button while it runs.
      aria-disabled={busy || undefined}
      aria-busy={checking || undefined}
      iconLeft={checking ? <Spinner className="h-3 w-3" /> : <RefreshGlyph />}
      onClick={() => {
        if (!busy) refresh();
      }}
    >
      {checking ? "Checking…" : "Check again"}
    </Button>
  );
}

function LinkedBar({
  association,
  actions,
  pr: worktreePr,
  drawerOpen,
  setDrawerOpen,
  toggleRef,
}: {
  association: Linked;
  actions: BarActions;
  pr: WorktreePr;
  drawerOpen: boolean;
  setDrawerOpen: (open: boolean) => void;
  toggleRef: Ref<HTMLButtonElement>;
}) {
  const { pr, readOnly } = association;
  const canOpen = isAbsoluteHttpUrl(pr.url);
  const drawerId = useId();
  const { now, freshness } = useChecksFreshness(worktreePr.entry);

  const countsLabel = checkCountsLabel(worktreePr.counts);
  const snapshot = worktreePr.entry.snapshot;
  const closeDrawer = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== "Escape" || event.nativeEvent.isComposing) return;
    event.preventDefault();
    event.stopPropagation();
    setDrawerOpen(false);
  };

  return (
    <>
      <div className="pr-assoc-row">
        <GitHubGlyph />
        {canOpen ? (
          <button
            type="button"
            className="pr-assoc-link"
            {...focusTarget}
            aria-label={`Open PR #${pr.number} on GitHub`}
            onClick={() => openExternalUrl(pr.url)}
          >
            <PrNumber number={pr.number} />
            <ExternalLinkGlyph />
          </button>
        ) : (
          <PrNumber number={pr.number} />
        )}
        <PrStateBadge state={pr.state} />
        <span className="pr-assoc-title" title={pr.title}>
          {pr.title}
        </span>
        {snapshot && (
          <button
            ref={toggleRef}
            type="button"
            className="pr-checks-toggle"
            aria-expanded={drawerOpen}
            aria-controls={drawerOpen ? drawerId : undefined}
            aria-label={`Checks: ${countsLabel}. ${drawerOpen ? "Hide" : "Show"} details`}
            data-testid="pr-checks-toggle"
            onClick={() => setDrawerOpen(!drawerOpen)}
          >
            <CheckCounts counts={worktreePr.counts} />
            <ChevronGlyph up={drawerOpen} />
          </button>
        )}
        {readOnly ? (
          <span className="pr-assoc-mute">Worktree not on this machine</span>
        ) : (
          <ChecksRefreshLine
            freshness={freshness}
            now={now}
            onRefresh={actions.refresh}
          />
        )}
        <span className="pr-assoc-actions">
          <OverflowMenu
            label={`PR #${pr.number} actions`}
            testId="pr-actions-menu"
            items={[
              ...(canOpen
                ? [
                    {
                      key: "open",
                      label: "Open on GitHub",
                      onSelect: () => openExternalUrl(pr.url),
                      icon: <ExternalLinkGlyph />,
                    },
                  ]
                : []),
              ...(readOnly
                ? []
                : [
                    {
                      // One poll reads the PR and its checks and updates both.
                      key: "refresh",
                      label: actions.refreshing ? "Checking…" : "Refresh PR",
                      onSelect: actions.refresh,
                      disabled: actions.busy,
                      icon: <RefreshGlyph />,
                    },
                    {
                      key: "unlink",
                      label: "Unlink PR (local only)",
                      onSelect: actions.unlink,
                      disabled: actions.busy,
                      separatorBefore: canOpen,
                      icon: <UnlinkGlyph />,
                      testId: "pr-unlink-action",
                    },
                  ]),
            ]}
          />
        </span>
      </div>
      {drawerOpen && snapshot && (
        <div onKeyDown={closeDrawer}>
          <PrChecksDrawer
            id={drawerId}
            prNumber={pr.number}
            checks={worktreePr.checks}
            truncated={snapshot.truncated}
            now={now}
            onRerun={(checkId) => void worktreePr.rerun(checkId)}
            onCancel={(checkId) => void worktreePr.cancel(checkId)}
          />
        </div>
      )}
    </>
  );
}

/** After the linked PR merged, a newer open PR of the branch is offered. */
function NewerPrRow({
  merged,
  newer,
  busy,
  onAccept,
  onDismiss,
}: {
  merged: number;
  newer: GithubPullRequest;
  busy: boolean;
  onAccept: () => void;
  onDismiss: () => void;
}) {
  return (
    <div className="pr-assoc-row" role="status" data-testid="pr-newer-prompt">
      <GitHubGlyph />
      <span className="pr-assoc-mute">
        PR #{merged} was merged. Link the newer #{newer.number}?
      </span>
      <span className="pr-assoc-actions">
        <Button
          variant="secondary"
          size="sm"
          {...focusTarget}
          aria-disabled={busy || undefined}
          iconLeft={<LinkGlyph />}
          onClick={() => {
            if (!busy) onAccept();
          }}
        >
          Link #{newer.number}
        </Button>
        <Button variant="ghost" size="sm" onClick={onDismiss}>
          Keep #{merged}
        </Button>
      </span>
    </div>
  );
}

function ChevronGlyph({ up }: { up: boolean }) {
  return (
    <Icon size="sm" strokeWidth={1.5}>
      <path d={up ? "m6 15 6-6 6 6" : "m6 9 6 6 6-6"} />
    </Icon>
  );
}

function ambiguousSummary({ branch, repo, candidates }: Ambiguous): ReactNode {
  const branchCode = <code className="pr-assoc-branch">{branch}</code>;
  if (candidates.length !== 1)
    return (
      <>
        {candidates.length} open PRs in {repo} match {branchCode}
      </>
    );
  const [only] = candidates;
  const fork =
    only.headRepo && only.headRepo.toLowerCase() !== repo.toLowerCase()
      ? only.headRepo
      : null;
  return fork ? (
    <>
      PR #{only.number} for {branchCode} is from fork {fork}, so it wasn’t
      linked automatically
    </>
  ) : (
    <>
      PR #{only.number} matches {branchCode} but wasn’t linked automatically
    </>
  );
}

function AmbiguousBar({
  association,
  actions,
}: {
  association: Ambiguous;
  actions: BarActions;
}) {
  const [open, setOpen] = useState(true);
  // Rows take focus only when the user opens the chooser, not on arrival.
  const [focusRows, setFocusRows] = useState(false);
  const toggleRef = useRef<HTMLButtonElement>(null);

  const toggle = () => {
    setFocusRows(!open);
    setOpen(!open);
  };

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== "Escape" || event.nativeEvent.isComposing) return;
    event.preventDefault();
    event.stopPropagation();
    setOpen(false);
    toggleRef.current?.focus();
  };

  return (
    <>
      <div className="pr-assoc-row">
        <GitHubGlyph />
        <span className="pr-assoc-warn">{ambiguousSummary(association)}</span>
        <span className="pr-assoc-actions">
          <Button
            ref={toggleRef}
            variant="secondary"
            size="sm"
            {...focusTarget}
            aria-expanded={open}
            onClick={toggle}
          >
            {open ? "Hide chooser" : "Choose PR…"}
          </Button>
        </span>
      </div>
      {open && (
        <div
          className="pr-chooser"
          data-testid="pr-ambiguous-chooser"
          onKeyDown={onKeyDown}
        >
          <PrCandidateList
            prs={association.candidates}
            repo={association.repo}
            busy={actions.busy}
            label={`Pull requests for ${association.branch}`}
            focusFirst={focusRows}
            onLink={(pr) => void actions.link(pr.number, prRepo(pr))}
          />
          <div className="pr-chooser-foot">
            <span className="pr-assoc-mute">
              ↑↓ move · ↵ link locally · esc close
            </span>
            <Button
              variant="ghost"
              size="sm"
              aria-disabled={actions.busy || undefined}
              onClick={() => {
                if (!actions.busy) actions.unlink();
              }}
            >
              Keep unlinked
            </Button>
          </div>
        </div>
      )}
    </>
  );
}

function NoPrBar({
  association,
  actions,
  linking,
  listOpenPrs,
  linkOpen,
  setLinkOpen,
  toggleRef,
}: {
  association: NoPr;
  actions: BarActions;
  linking: boolean;
  listOpenPrs: () => Promise<GithubPullRequest[]>;
  linkOpen: boolean;
  setLinkOpen: (open: boolean) => void;
  toggleRef: Ref<HTMLButtonElement>;
}) {
  const { branch, repo, createPrUrl } = association;

  return (
    <>
      <div className="pr-assoc-row">
        <GitHubGlyph />
        <span className="pr-assoc-mute">
          No PR for <code className="pr-assoc-branch">{branch}</code> in {repo}
        </span>
        <span className="pr-assoc-actions">
          <Button
            ref={toggleRef}
            variant="secondary"
            size="sm"
            {...focusTarget}
            aria-expanded={linkOpen}
            iconLeft={<LinkGlyph />}
            onClick={() => setLinkOpen(!linkOpen)}
          >
            Link PR…
          </Button>
          {isAbsoluteHttpUrl(createPrUrl) && (
            <Button
              variant="secondary"
              size="sm"
              iconLeft={<NewPrGlyph />}
              iconRight={<ExternalLinkGlyph />}
              onClick={() => openExternalUrl(createPrUrl)}
            >
              Create PR on GitHub
            </Button>
          )}
          <CheckAgainButton {...actions} />
        </span>
      </div>
      {linkOpen && (
        <ManualPrLink
          repo={repo}
          busy={actions.busy}
          linking={linking}
          onLink={actions.link}
          listOpenPrs={listOpenPrs}
          onClose={() => setLinkOpen(false)}
        />
      )}
    </>
  );
}

interface PanelProps {
  panel: Panel;
  setPanel: (panel: Panel) => void;
  toggleRef: Ref<HTMLButtonElement>;
}

function AssociationBody({
  association,
  actions,
  pr,
  panel,
  setPanel,
  toggleRef,
}: {
  association: WorktreePrAssociation | null;
  actions: BarActions;
  pr: WorktreePr;
} & PanelProps): ReactNode {
  if (!association)
    return (
      <PrStatusRow tone="plain" icon={<Spinner className="h-3 w-3" />}>
        Looking for a GitHub pull request…
      </PrStatusRow>
    );

  switch (association.status) {
    case "not_applicable":
      return null;
    case "unavailable":
      return (
        <PrStatusRow action={<CheckAgainButton {...actions} />}>
          Couldn’t check GitHub PR:{" "}
          <GithubFailureText failure={association.error} />
        </PrStatusRow>
      );
    case "gh_missing":
      return (
        <PrStatusRow tone="plain" action={<CheckAgainButton {...actions} />}>
          <GhMissingText />
        </PrStatusRow>
      );
    case "auth_expired":
      return (
        <PrStatusRow tone="error" action={<CheckAgainButton {...actions} />}>
          <AuthExpiredText />
        </PrStatusRow>
      );
    case "linked":
      return (
        <LinkedBar
          association={association}
          actions={actions}
          pr={pr}
          drawerOpen={panel === "checks"}
          setDrawerOpen={(open) => setPanel(open ? "checks" : null)}
          toggleRef={toggleRef}
        />
      );
    case "ambiguous":
      return (
        <AmbiguousBar
          key={association.branch}
          association={association}
          actions={actions}
        />
      );
    case "none":
      return (
        <NoPrBar
          key={association.branch}
          association={association}
          actions={actions}
          linking={pr.entry.linking}
          listOpenPrs={pr.listOpenPrs}
          linkOpen={panel === "link"}
          setLinkOpen={(open) => setPanel(open ? "link" : null)}
          toggleRef={toggleRef}
        />
      );
    default: {
      const unreachable: never = association;
      return unreachable;
    }
  }
}

function offersCheckAgain(association: WorktreePrAssociation | null): boolean {
  return (
    association?.status !== "linked" && association?.status !== "ambiguous"
  );
}

/** What the bar shows: a panel opened in one view closes when it changes. */
function viewKey(association: WorktreePrAssociation | null): string {
  if (association?.status === "linked")
    return `linked:${association.repo}#${association.pr.number}`;
  if (association?.status === "none" || association?.status === "ambiguous")
    return `${association.status}:${association.branch}`;
  return association?.status ?? "loading";
}

/** The bar's panels, for the ⌘K entries of Changes. */
export interface PrBarHandle {
  /** Whether the checks drawer is open; `null` while there are no checks. */
  checksOpen: boolean | null;
  toggleChecks: () => void;
  /** Opens Link PR…; `null` when the bar does not offer it. */
  openLink: (() => void) | null;
}

export function PrAssociationBar({
  pr,
  ref,
}: {
  pr: WorktreePr;
  ref?: Ref<PrBarHandle>;
}) {
  const { association, busy, entry } = pr;
  const rootRef = useRef<HTMLDivElement>(null);
  const toggleRef = useRef<HTMLButtonElement>(null);
  const restoreFocus = useRef(false);
  const shown = viewKey(association);
  const [opened, setOpened] = useState<{ panel: Panel; in: string }>({
    panel: null,
    in: shown,
  });
  const panel = opened.in === shown ? opened.panel : null;
  const setPanel = (next: Panel) => {
    setOpened({ panel: next, in: shown });
    // Closing a panel hands focus back to the control that opened it.
    if (next === null) toggleRef.current?.focus();
  };

  const hasChecks = association?.status === "linked" && !!entry.snapshot;
  useImperativeHandle(
    ref,
    () => ({
      checksOpen: hasChecks ? panel === "checks" : null,
      toggleChecks: () => {
        if (!hasChecks) return;
        setOpened({ panel: panel === "checks" ? null : "checks", in: shown });
        requestAnimationFrame(() => toggleRef.current?.focus());
      },
      openLink:
        association?.status === "none"
          ? () => setOpened({ panel: "link", in: shown })
          : null,
    }),
    [association?.status, hasChecks, panel, shown]
  );

  // When an action swaps the bar's contents, focus would fall to <body>;
  // hand it to the new state's main control instead.
  useLayoutEffect(() => {
    if (!restoreFocus.current) return;
    restoreFocus.current = false;
    const active = document.activeElement;
    if (active && active !== document.body) return;
    rootRef.current?.querySelector<HTMLElement>(`[${FOCUS_TARGET}]`)?.focus();
  }, [shown]);

  const track = (run: () => Promise<boolean>) => {
    restoreFocus.current = true;
    return run().then((ok) => {
      if (!ok) restoreFocus.current = false;
      return ok;
    });
  };

  const actions: BarActions = {
    busy,
    refreshing: entry.read.status === "refreshing",
    refresh: () => void track(pr.refresh),
    link: (prNumber, repo) => track(() => pr.linkPr(prNumber, repo)),
    unlink: () => void track(pr.unlinkPr),
  };

  if (association?.status === "not_applicable") return null;
  const error = entry.error;

  return (
    <div
      ref={rootRef}
      className="pr-assoc-bar"
      data-testid="pr-association-bar"
    >
      <AssociationBody
        association={association}
        actions={actions}
        pr={pr}
        panel={panel}
        setPanel={setPanel}
        toggleRef={toggleRef}
      />
      {entry.newer && association?.status === "linked" && (
        <NewerPrRow
          merged={association.pr.number}
          newer={entry.newer}
          busy={busy}
          onAccept={() => void track(pr.acceptNewer)}
          onDismiss={pr.dismissNewer}
        />
      )}
      {error && (
        <div className="pr-assoc-row" role="alert">
          <span className="pr-assoc-err">
            <GithubFailureText failure={error} />
          </span>
          {needsUserFix(error) && !offersCheckAgain(association) && (
            <span className="pr-assoc-actions">
              <CheckAgainButton {...actions} />
            </span>
          )}
        </div>
      )}
    </div>
  );
}

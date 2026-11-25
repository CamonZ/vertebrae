import type { GithubPrState, GithubPullRequest } from "../../bindings";
import { Badge, type BadgeIntent } from "../atoms/Badge";
import { Icon, type IconSize } from "../atoms/Icon";
import { PR_STATE_LABEL } from "./githubPrState";
import "./githubPr.css";

const PR_STATE_INTENT: Record<GithubPrState, BadgeIntent> = {
  open: "success",
  draft: "neutral",
  merged: "info",
  closed: "error",
};

export function GitHubGlyph({
  size = "sm",
  label,
}: {
  size?: IconSize;
  label?: string;
}) {
  return (
    <Icon
      size={size}
      label={label}
      viewBox="0 0 16 16"
      fill="currentColor"
      stroke="none"
      className="pr-gh-glyph"
    >
      <path d="M8 0c4.42 0 8 3.58 8 8a8.013 8.013 0 0 1-5.45 7.59c-.4.08-.55-.17-.55-.38 0-.27.01-1.13.01-2.2 0-.75-.25-1.23-.54-1.48 1.78-.2 3.65-.88 3.65-3.95 0-.88-.31-1.59-.82-2.15.08-.2.36-1.02-.08-2.12 0 0-.67-.22-2.2.82-.64-.18-1.32-.27-2-.27-.68 0-1.36.09-2 .27-1.53-1.03-2.2-.82-2.2-.82-.44 1.1-.16 1.92-.08 2.12-.51.56-.82 1.28-.82 2.15 0 3.06 1.86 3.75 3.64 3.95-.23.2-.44.55-.51 1.07-.46.21-1.61.55-2.33-.66-.15-.24-.6-.83-1.23-.82-.67.01-.27.38.01.53.34.19.73.9.82 1.13.16.45.68 1.31 2.69.94 0 .67.01 1.3.01 1.49 0 .21-.15.45-.55.38A7.995 7.995 0 0 1 0 8c0-4.42 3.58-8 8-8Z" />
    </Icon>
  );
}

export function ExternalLinkGlyph() {
  return (
    <Icon size="xs">
      <path d="M15 3h6v6M21 3l-9 9M19 14v5a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2h5" />
    </Icon>
  );
}

export function PrStateBadge({ state }: { state: GithubPrState }) {
  return <Badge intent={PR_STATE_INTENT[state]}>{PR_STATE_LABEL[state]}</Badge>;
}

export function PrNumber({ number }: { number: number }) {
  return <span className="pr-number">#{number}</span>;
}

export function ChatHeaderPrChip({
  pr,
  openThreads = null,
  onOpenChanges,
}: {
  pr: GithubPullRequest;
  /** Unresolved review threads; null until they are read. */
  openThreads?: number | null;
  onOpenChanges?: () => void;
}) {
  const summary = `PR #${pr.number} · ${PR_STATE_LABEL[pr.state]} · ${pr.title}`;
  const threads =
    openThreads === null
      ? ""
      : `, ${openThreads} open ${openThreads === 1 ? "thread" : "threads"}`;
  const content = (
    <>
      <GitHubGlyph size="xs" />
      <PrNumber number={pr.number} />
      <PrStateBadge state={pr.state} />
      {openThreads !== null && openThreads > 0 && (
        <span className="pr-chip-threads" aria-hidden="true">
          {openThreads}
        </span>
      )}
    </>
  );
  if (!onOpenChanges) {
    return (
      <span
        className="pr-header-chip"
        title={summary}
        data-testid="chat-header-pr-chip"
      >
        {content}
      </span>
    );
  }
  return (
    <button
      type="button"
      className="pr-header-chip is-action"
      aria-label={`Review PR #${pr.number} in Changes${threads}`}
      title={summary}
      data-testid="chat-header-pr-chip"
      onClick={onOpenChanges}
    >
      {content}
    </button>
  );
}

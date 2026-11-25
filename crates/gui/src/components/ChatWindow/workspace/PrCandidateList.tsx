import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import type { GithubPullRequest } from "../../../bindings";
import { formatRelative } from "../../../utils/formatRelative";
import { stepRow } from "../chatAreas";
import { PrNumber, PrStateBadge } from "../GithubPr";
import { PR_STATE_LABEL } from "../githubPrState";

const ROW_SELECTOR = "[data-pr-candidate]";

interface MetaItem {
  key: string;
  text: string;
  warn: boolean;
}

function candidateMeta(pr: GithubPullRequest, repo: string): MetaItem[] {
  const items: MetaItem[] = [];
  if (pr.author)
    items.push({ key: "author", text: `by ${pr.author}`, warn: false });
  if (pr.headRepo && pr.headRepo.toLowerCase() !== repo.toLowerCase())
    items.push({ key: "fork", text: `fork ${pr.headRepo}`, warn: true });
  items.push({
    key: "refs",
    text: `${pr.headRef} → ${pr.baseRef}`,
    warn: false,
  });
  const updated = formatRelative(pr.updatedAt);
  if (updated)
    items.push({ key: "updated", text: `updated ${updated}`, warn: false });
  return items;
}

function CandidateRow({
  pr,
  repo,
  isTabStop,
  busy,
  onFocus,
  onLink,
}: {
  pr: GithubPullRequest;
  repo: string;
  isTabStop: boolean;
  busy: boolean;
  onFocus: () => void;
  onLink: (pr: GithubPullRequest) => void;
}) {
  const meta = candidateMeta(pr, repo);
  const description = [
    `#${pr.number} ${pr.title}`,
    PR_STATE_LABEL[pr.state],
    ...meta.map((item) => item.text),
  ].join(", ");
  return (
    <li>
      <button
        type="button"
        className="pr-candidate"
        data-pr-candidate=""
        tabIndex={isTabStop ? 0 : -1}
        aria-disabled={busy || undefined}
        aria-label={`Link locally: ${description}`}
        onFocus={onFocus}
        onClick={() => {
          if (!busy) onLink(pr);
        }}
      >
        <span className="pr-candidate-head">
          <PrNumber number={pr.number} />
          <PrStateBadge state={pr.state} />
          <span className="pr-assoc-title">{pr.title}</span>
          <span className="pr-candidate-commit" aria-hidden="true">
            Link locally
          </span>
        </span>
        <span className="pr-candidate-meta">
          {meta.map((item) => (
            <span key={item.key} className={item.warn ? "is-warn" : undefined}>
              {item.text}
            </span>
          ))}
        </span>
      </button>
    </li>
  );
}

export function PrCandidateList({
  prs,
  repo,
  busy,
  label,
  focusFirst = false,
  onLink,
}: {
  prs: readonly GithubPullRequest[];
  repo: string;
  busy: boolean;
  label: string;
  focusFirst?: boolean;
  onLink: (pr: GithubPullRequest) => void;
}) {
  const listRef = useRef<HTMLUListElement>(null);
  const [active, setActive] = useState<number | null>(null);
  const tabStop = prs.some((pr) => pr.number === active)
    ? active
    : (prs[0]?.number ?? null);

  useEffect(() => {
    if (focusFirst)
      listRef.current?.querySelector<HTMLElement>(ROW_SELECTOR)?.focus();
  }, [focusFirst]);

  const onKeyDown = (event: KeyboardEvent<HTMLUListElement>) => {
    if (event.nativeEvent.isComposing) return;
    if (event.metaKey || event.ctrlKey || event.altKey || event.shiftKey)
      return;
    const list = event.currentTarget;
    const from = event.target instanceof HTMLElement ? event.target : null;
    if (event.key === "ArrowDown") stepRow(list, ROW_SELECTOR, from, 1);
    else if (event.key === "ArrowUp") stepRow(list, ROW_SELECTOR, from, -1);
    else if (event.key === "Home") stepRow(list, ROW_SELECTOR, null, 1);
    else if (event.key === "End") stepRow(list, ROW_SELECTOR, null, -1);
    else return;
    event.preventDefault();
  };

  return (
    <ul
      ref={listRef}
      className="pr-candidate-list"
      aria-label={label}
      onKeyDown={onKeyDown}
    >
      {prs.map((pr) => (
        <CandidateRow
          key={pr.number}
          pr={pr}
          repo={repo}
          isTabStop={pr.number === tabStop}
          busy={busy}
          onFocus={() => setActive(pr.number)}
          onLink={onLink}
        />
      ))}
    </ul>
  );
}

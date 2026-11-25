import {
  useEffect,
  useId,
  useRef,
  useState,
  type FormEvent,
  type KeyboardEvent,
} from "react";
import type { GithubFailure, GithubPullRequest } from "../../../bindings";
import { githubFailureOf } from "../../../stores/worktreePrStore";
import { Button } from "../../atoms/Button";
import { Input } from "../../atoms/Input";
import { Spinner } from "../../Spinner";
import { PrCandidateList } from "./PrCandidateList";
import { GithubFailureText } from "./PrFailure";
import { parsePrReference } from "./prReference";

/** Open PRs listed under the number field; the rest stay reachable by number. */
export const OPEN_PR_LIST_LIMIT = 8;

type OpenPrs =
  | { status: "loading" }
  | { status: "ready"; prs: GithubPullRequest[] }
  | { status: "error"; failure: GithubFailure };

function OpenPrList({
  openPrs,
  repo,
  busy,
  onLink,
  onRetry,
}: {
  openPrs: OpenPrs;
  repo: string;
  busy: boolean;
  onLink: (pr: GithubPullRequest) => void;
  onRetry: () => void;
}) {
  switch (openPrs.status) {
    case "loading":
      return (
        <span className="pr-assoc-mute" role="status">
          Loading open PRs…
        </span>
      );
    case "error":
      return (
        <div className="pr-assoc-row" role="alert">
          <span className="pr-assoc-err">
            Couldn’t load open PRs:{" "}
            <GithubFailureText failure={openPrs.failure} />
          </span>
          <Button variant="secondary" size="sm" onClick={onRetry}>
            Retry
          </Button>
        </div>
      );
    case "ready": {
      const { prs } = openPrs;
      if (prs.length === 0)
        return <span className="pr-assoc-mute">No open PRs in {repo}.</span>;
      const shown = prs.slice(0, OPEN_PR_LIST_LIMIT);
      return (
        <>
          <PrCandidateList
            prs={shown}
            repo={repo}
            busy={busy}
            label={`Open pull requests in ${repo}`}
            onLink={onLink}
          />
          {shown.length < prs.length && (
            <span className="pr-assoc-mute">
              Showing {shown.length} of {prs.length} open PRs · enter a number
              to link another
            </span>
          )}
        </>
      );
    }
    default: {
      const unreachable: never = openPrs;
      return unreachable;
    }
  }
}

export function ManualPrLink({
  repo,
  busy,
  linking,
  onLink,
  listOpenPrs,
  onClose,
}: {
  repo: string;
  busy: boolean;
  linking: boolean;
  /** `repo` is the PR's `owner/name`; null for the base repository. */
  onLink: (prNumber: number, repo: string | null) => Promise<boolean>;
  listOpenPrs: () => Promise<GithubPullRequest[]>;
  onClose: () => void;
}) {
  const inputId = useId();
  const errorId = useId();
  const inputRef = useRef<HTMLInputElement>(null);
  const [text, setText] = useState("");
  const [fieldError, setFieldError] = useState<string | null>(null);
  const [openPrs, setOpenPrs] = useState<OpenPrs>({ status: "loading" });
  const [listAttempt, setListAttempt] = useState(0);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  useEffect(() => {
    let current = true;
    listOpenPrs().then(
      (prs) => {
        if (current) setOpenPrs({ status: "ready", prs });
      },
      (error: unknown) => {
        if (current)
          setOpenPrs({ status: "error", failure: githubFailureOf(error) });
      }
    );
    return () => {
      current = false;
    };
  }, [listOpenPrs, listAttempt]);

  const retryList = () => {
    setOpenPrs({ status: "loading" });
    setListAttempt((attempt) => attempt + 1);
  };

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (busy) return;
    const parsed = parsePrReference(text, repo);
    if (!parsed.ok) {
      setFieldError(parsed.message);
      inputRef.current?.focus();
      return;
    }
    setFieldError(null);
    if (!(await onLink(parsed.number, parsed.repo))) inputRef.current?.focus();
  };

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== "Escape" || event.nativeEvent.isComposing) return;
    event.preventDefault();
    event.stopPropagation();
    onClose();
  };

  return (
    <div
      className="pr-manual-link"
      data-testid="pr-manual-link-panel"
      onKeyDown={onKeyDown}
    >
      <form className="pr-manual-form" onSubmit={(event) => void submit(event)}>
        <label className="sr-only" htmlFor={inputId}>
          Pull request number or URL
        </label>
        <Input
          ref={inputRef}
          id={inputId}
          mono
          className="pr-manual-input"
          inputMode="text"
          autoComplete="off"
          spellCheck={false}
          placeholder="#123"
          value={text}
          // readOnly rather than disabled keeps focus here while linking.
          readOnly={busy}
          invalid={fieldError !== null}
          aria-describedby={fieldError ? errorId : undefined}
          onChange={(event) => {
            setText(event.target.value);
            setFieldError(null);
          }}
        />
        <Button
          type="submit"
          size="sm"
          className="pr-private-action"
          aria-disabled={busy || undefined}
          aria-busy={linking || undefined}
          iconLeft={linking ? <Spinner className="h-3 w-3" /> : undefined}
        >
          Link locally
        </Button>
        <Button variant="secondary" size="sm" onClick={onClose}>
          Cancel
        </Button>
      </form>
      {fieldError && (
        <span id={errorId} className="pr-assoc-err" role="alert">
          {fieldError}
        </span>
      )}
      <OpenPrList
        openPrs={openPrs}
        repo={repo}
        busy={busy}
        onLink={(pr) => void onLink(pr.number, `${pr.owner}/${pr.repo}`)}
        onRetry={retryList}
      />
    </div>
  );
}

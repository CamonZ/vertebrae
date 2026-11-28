/**
 * Controls that post to GitHub: neutral, with the GitHub glyph (private
 * Vertebrae actions keep the accent). Every post names its target, PR and
 * lines, and its audience before it is sent, and only a click or ⌘↵
 * sends it.
 */
import {
  useEffect,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode,
} from "react";
import { ExternalLinkGlyph, GitHubGlyph } from "../../GithubPr";
import {
  isAbsoluteHttpUrl,
  openExternalUrl,
} from "../../../../utils/openExternalUrl";
import {
  threadLane,
  type ThreadWrites,
  type WriteFailure,
  type WritePlan,
  type WritePort,
} from "./threadWrites";
import { useWriteSlot } from "./threadWritesContext";
import {
  DIFF_COMPOSER_SUBMIT_SHORTCUT,
  shortcutText,
} from "../../chatShortcuts";

export function GithubPostButton({
  children,
  onClick,
  primary = false,
  pending = false,
  disabled = false,
  title,
  keyShortcuts,
}: {
  children: ReactNode;
  onClick(): void;
  /** The row's main post: filled neutral, never the private accent. */
  primary?: boolean;
  /** Its write is out; the button stays in place and says so. */
  pending?: boolean;
  disabled?: boolean;
  title?: string;
  /** Its `aria-keyshortcuts`, e.g. `Meta+Alt+Enter`. */
  keyShortcuts?: string;
}) {
  return (
    <button
      type="button"
      className="gh-post-button"
      data-github-primary={primary || undefined}
      disabled={disabled || pending}
      aria-busy={pending || undefined}
      title={title}
      aria-keyshortcuts={keyShortcuts}
      onClick={onClick}
    >
      {pending ? (
        <span className="gh-spinner" aria-hidden="true" />
      ) : (
        <GitHubGlyph size="xs" />
      )}
      {children}
    </button>
  );
}

/** Opens `url` on GitHub, where the user can act when Vertebrae cannot. */
export function OnGithubLink({
  url,
  children,
}: {
  url: string | null;
  children: ReactNode;
}) {
  if (!url || !isAbsoluteHttpUrl(url)) return null;
  return (
    <button
      type="button"
      className="gh-text-button gh-inline"
      onClick={() => openExternalUrl(url)}
    >
      {children}
      <ExternalLinkGlyph />
    </button>
  );
}

const VERB = {
  reply: "Reply",
  resolve: "Resolve",
  reopen: "Reopen",
  start: "Comment",
} as const;

function failureText(
  failure: WriteFailure,
  draftKept: boolean
): { title: string; detail: string } {
  const verb = VERB[failure.sent.kind];
  const noun = verb.toLowerCase();
  const posts = failure.sent.kind === "reply" || failure.sent.kind === "start";
  const kept = failure.replied
    ? " Your reply is kept."
    : draftKept
      ? " Your draft is kept."
      : "";
  const title = failure.replied
    ? "Reply posted. Resolve failed."
    : failure.kind === "forbidden"
      ? `GitHub refused the ${noun}.`
      : failure.kind === "rejected"
        ? `The ${noun} wasn’t sent.`
        : failure.kind === "ambiguous" || failure.kind === "unconfirmed"
          ? `GitHub didn’t confirm the ${noun}.`
          : posts
            ? `${verb} didn’t post.`
            : `${verb} failed.`;
  const detail =
    failure.kind === "forbidden"
      ? "GitHub returned 403: you can’t do this here, so retrying can’t help."
      : failure.kind === "rejected"
        ? `${failure.message}${posts && draftKept ? " Change the text and post again." : ""}`
        : failure.kind === "ambiguous"
          ? `It may have ${posts ? "posted" : "applied"}; retrying checks the thread first so nothing posts twice.`
          : failure.message;
  return { title, detail: detail + kept };
}

/**
 * A failed write. A 403 or a rejected write never offers Retry, only the
 * way round on GitHub; an ambiguous write's Retry checks the thread first.
 */
export function WriteFailureAlert({
  failure,
  draftKept,
  url,
  pending,
  onRetry,
}: {
  failure: WriteFailure;
  draftKept: boolean;
  /** Where to finish the write on GitHub. */
  url: string | null;
  pending: boolean;
  onRetry(): void;
}) {
  const { title, detail } = failureText(failure, draftKept);
  const verb = VERB[failure.sent.kind];
  const retry =
    failure.kind === "transient"
      ? `Retry ${verb.toLowerCase()}`
      : failure.kind === "ambiguous"
        ? "Check thread and retry"
        : null;
  return (
    <div className="gh-write-alert" role="alert">
      <p>
        <strong>{title}</strong> {detail}
      </p>
      <div className="gh-write-alert-actions">
        {retry && (
          <button
            type="button"
            className="gh-text-button"
            disabled={pending}
            aria-busy={pending || undefined}
            onClick={onRetry}
          >
            {retry}
          </button>
        )}
        <OnGithubLink url={url}>{verb} on GitHub</OnGithubLink>
      </div>
    </div>
  );
}

export interface ComposerPost {
  label: string;
  plan: WritePlan;
  primary?: boolean;
}

/**
 * A public composer: what it posts to and who sees it, the text, and its
 * posts, with the failure of its text (a thread's resolve or reopen shows
 * with the thread instead). ⌘↵ sends the primary post.
 * Closed by Discard (with Undo) or by posting; anything else keeps it.
 * Opening it (or Undo) brings it into view and focuses its text; showing a
 * kept draft again does not.
 */
export function GithubComposer({
  store,
  slotKey,
  title,
  audience,
  textLabel,
  placeholder,
  posts,
  port,
  url,
  onEscape,
}: {
  store: ThreadWrites;
  slotKey: string;
  title: string;
  /** Target and audience: "#12, src/a.rs:4 · visible to everyone as …". */
  audience: string;
  textLabel: string;
  placeholder: string;
  posts: readonly ComposerPost[];
  port: WritePort;
  url: string | null;
  onEscape?(): void;
}) {
  const slot = useWriteSlot(store, slotKey);
  const [posted, setPosted] = useState<string | null>(null);
  const draft = slot.draft;
  const open = draft !== null;
  const section = useRef<HTMLElement>(null);
  const text = useRef<HTMLTextAreaElement>(null);
  const undo = useRef<HTMLButtonElement>(null);
  const discarding = useRef(false);
  const wasOpen = useRef(open);
  useEffect(() => {
    if (open && !wasOpen.current) {
      section.current?.scrollIntoView?.({ block: "nearest" });
      text.current?.focus({ preventScroll: true });
    }
    // Discard here takes the focused text away; Undo is where it goes. The
    // same draft shown elsewhere leaves the focus alone.
    if (!open && discarding.current)
      undo.current?.focus({ preventScroll: true });
    discarding.current = false;
    wasOpen.current = open;
  }, [open]);
  if (draft === null)
    return slot.discarded !== null ? (
      <p className="gh-undo-row" role="status">
        {title} draft discarded.
        <button
          ref={undo}
          type="button"
          className="gh-text-button"
          onClick={() => store.undo(slotKey)}
        >
          Undo
        </button>
      </p>
    ) : null;
  const busy = slot.pending !== null;
  const empty = !draft.trim();
  const primary = posts.find((post) => post.primary) ?? posts[0];
  const post = ({ label, plan }: ComposerPost) => {
    setPosted(label);
    void store.post(slotKey, plan, port);
  };
  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.nativeEvent.isComposing) return;
    if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
      event.preventDefault();
      event.stopPropagation();
      if (event.repeat || empty || busy || !primary) return;
      post(primary);
    } else if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      onEscape?.();
    }
  };
  const hint = busy
    ? "Posting…"
    : `${
        primary
          ? `${shortcutText(DIFF_COMPOSER_SUBMIT_SHORTCUT)} ${primary.label.toLowerCase()} · `
          : ""
      }draft kept if you close`;
  return (
    <section ref={section} className="gh-composer" aria-label={title}>
      <header className="gh-composer-head">
        <GitHubGlyph size="xs" />
        <span>{title}</span>
        <span className="gh-mute">{audience}</span>
      </header>
      <textarea
        ref={text}
        className="gh-composer-text"
        aria-label={textLabel}
        rows={3}
        placeholder={placeholder}
        value={draft}
        onChange={(event) => store.edit(slotKey, event.target.value)}
        onKeyDown={onKeyDown}
      />
      {slot.failure && !threadLane(slot.failure) && (
        <WriteFailureAlert
          failure={slot.failure}
          draftKept
          url={url}
          pending={busy}
          onRetry={() => void store.retry(slotKey, port)}
        />
      )}
      <div className="diff-comment-editor-actions gh-composer-actions">
        <span className="diff-comment-editor-hint" role="status">
          {hint}
        </span>
        <div className="diff-comment-editor-buttons">
          <button
            type="button"
            disabled={busy}
            onClick={() => {
              discarding.current = true;
              store.discard(slotKey);
            }}
          >
            Discard
          </button>
          {posts.map((item) => (
            <GithubPostButton
              key={item.label}
              primary={item === primary}
              pending={busy && item.label === (posted ?? primary?.label)}
              disabled={empty || busy}
              onClick={() => post(item)}
            >
              {item.label}
            </GithubPostButton>
          ))}
        </div>
      </div>
    </section>
  );
}

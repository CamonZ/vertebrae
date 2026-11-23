import { useContext, useRef, type KeyboardEvent } from "react";
import { CHAT_AREA_ATTRIBUTE, enterFirstRow } from "./chatAreas";
import {
  DIFF_COPY_SHORTCUT,
  DISCUSSION_LIST_HINTS,
  DISCUSSION_OPEN_KEY,
  matchesExactChatShortcut,
} from "./chatShortcuts";
import { MiniThread } from "./SelectionDiscussionContext";
import {
  anchorNotice,
  discussionList,
  selectionLabel,
  threadPlace,
  THREAD_PLACES,
  type SelectionThread,
  type ThreadPlace,
} from "./selectionDiscussions";
import {
  SelectionDiscussionContext,
  type DiscussionValue,
} from "./selectionDiscussionState";

const ROW_ATTRIBUTE = "data-discussion-row";

const GROUP: Record<ThreadPlace, { title: string; description?: string }> = {
  detached: {
    title: "Detached",
    description: "The code changed or moved; the original selection is kept.",
  },
  changes: { title: "In Changes" },
  transcript: {
    title: "In the transcript",
    description: "Anchored on a tool call's patch in the chat.",
  },
  document: {
    title: "In open files",
    description: "Anchored on a whole file opened from Changes.",
  },
};

function copy(text: string) {
  navigator.clipboard.writeText(text).catch((error: unknown) => {
    console.error("Failed to copy original code", error);
  });
}

function rows(list: HTMLElement): HTMLElement[] {
  return Array.from(list.querySelectorAll<HTMLElement>(`[${ROW_ATTRIBUTE}]`));
}

function focusRow(list: HTMLElement | null, id: string) {
  // The row replaces the closed thread's card on the next render.
  requestAnimationFrame(() =>
    list
      ?.querySelector<HTMLElement>(`[${ROW_ATTRIBUTE}="${CSS.escape(id)}"]`)
      ?.focus({ preventScroll: false })
  );
}

/**
 * The Discussions section of a chat's side column (db5160ff): every
 * selection thread of the chat, detached ones first with their original
 * code, then grouped by where each is drawn. One list, ↑/↓ between rows.
 */
export function SideDiscussions() {
  const discussion = useContext(SelectionDiscussionContext);
  const listRef = useRef<HTMLElement>(null);
  if (!discussion) return null;
  const returnTo = (id: string) => focusRow(listRef.current, id);
  const groups = discussionList(discussion.threads);
  const empty = discussion.threads.length === 0;

  const onKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    if (event.defaultPrevented || event.nativeEvent.isComposing) return;
    const list = event.currentTarget;
    const target = event.target as HTMLElement;
    const all = rows(list);
    const plain =
      !event.metaKey && !event.ctrlKey && !event.altKey && !event.shiftKey;
    const step =
      event.key === "ArrowDown" ? 1 : event.key === "ArrowUp" ? -1 : 0;
    // From the section itself (⌘⌥→ lands here) the arrows enter the list.
    if (target === list) {
      if (!plain || !step || all.length === 0) return;
      event.preventDefault();
      (step === 1 ? all[0] : all[all.length - 1]).focus();
      return;
    }
    const id = target.getAttribute(ROW_ATTRIBUTE);
    const thread = id ? discussion.threads.find((t) => t.id === id) : null;
    if (!thread) return;
    if (plain && step) {
      event.preventDefault();
      all[Math.min(all.length - 1, Math.max(0, all.indexOf(target) + step))]
        ?.focus();
    } else if (plain && event.key === "Enter") {
      event.preventDefault();
      discussion.reopen(thread.id, { focus: true, inPlace: true });
    } else if (
      plain &&
      event.key.toLowerCase() === DISCUSSION_OPEN_KEY &&
      threadPlace(thread) === "changes"
    ) {
      event.preventDefault();
      // Not in place: the thread opens at its anchor in Changes.
      discussion.reopen(thread.id, { focus: true });
    } else if (matchesExactChatShortcut(event, DIFF_COPY_SHORTCUT)) {
      event.preventDefault();
      copy(thread.git.original.code);
    } else if (plain && (event.key === "ArrowLeft" || event.key === "ArrowRight")) {
      const collapsed = discussion.collapsed.has(thread.id);
      if (collapsed !== (event.key === "ArrowLeft")) {
        event.preventDefault();
        discussion.toggleCollapsed(thread.id);
      }
    }
  };

  return (
    <section
      ref={listRef}
      className="side-discussions"
      aria-label="Discussions"
      tabIndex={-1}
      {...{ [CHAT_AREA_ATTRIBUTE]: "discussions" }}
      onKeyDown={onKeyDown}
      onFocus={(event) => enterFirstRow(event, `[${ROW_ATTRIBUTE}]`)}
    >
      {discussion.anchorError && (
        <p role="alert" className="side-discussions-alert">
          {discussion.anchorError}
        </p>
      )}
      {empty ? (
        <p className="side-discussions-empty">
          No discussions yet. Select code in Changes and press c to ask about
          it.
        </p>
      ) : (
        THREAD_PLACES.map((place) => (
          <DiscussionGroup
            key={place}
            {...GROUP[place]}
            threads={groups[place]}
            discussion={discussion}
            onClosed={returnTo}
          />
        ))
      )}
      <footer className="side-section-hints" aria-label="Discussions keys">
        {DISCUSSION_LIST_HINTS.map(({ keys, label }) => (
          <span key={label}>
            <kbd>{keys.join("")}</kbd> {label}
          </span>
        ))}
      </footer>
    </section>
  );
}

function DiscussionGroup({
  title,
  description,
  threads,
  discussion,
  onClosed,
}: {
  title: string;
  description?: string;
  threads: readonly SelectionThread[];
  discussion: DiscussionValue;
  onClosed(id: string): void;
}) {
  if (threads.length === 0) return null;
  return (
    <div
      className="side-discussions-group"
      role="group"
      aria-label={`${title}, ${threads.length}`}
    >
      <h3 className="side-discussions-heading" title={description}>
        {title} <span className="changes-files-count">{threads.length}</span>
      </h3>
      <ul>
        {threads.map((thread) => (
          <DiscussionRow
            key={thread.id}
            thread={thread}
            discussion={discussion}
            onClosed={onClosed}
          />
        ))}
      </ul>
    </div>
  );
}

function DiscussionRow({
  thread,
  discussion,
  onClosed,
}: {
  thread: SelectionThread;
  discussion: DiscussionValue;
  onClosed(id: string): void;
}) {
  const notice = anchorNotice(thread.status);
  const place = threadPlace(thread);
  const detached = place === "detached";
  if (discussion.activeId === thread.id) {
    return (
      <li className="side-discussion" data-thread-id={thread.id}>
        <MiniThread
          thread={thread}
          discussion={discussion}
          onClosed={() => onClosed(thread.id)}
        />
      </li>
    );
  }
  const label = selectionLabel(thread.anchor);
  return (
    <li className="side-discussion" data-thread-id={thread.id}>
      <button
        type="button"
        className="side-discussion-row"
        {...{ [ROW_ATTRIBUTE]: thread.id }}
        aria-label={`Discussion on ${label}${notice ? `, ${notice.label}` : ""}`}
        aria-keyshortcuts={
          place === "changes"
            ? `Enter ${DISCUSSION_OPEN_KEY} Meta+C`
            : "Enter Meta+C"
        }
        title={
          place === "changes"
            ? "Open discussion (↵) · show in Changes (o) · copy code (⌘C)"
            : `Open discussion (↵) · copy ${detached ? "original " : ""}code (⌘C)`
        }
        onClick={() =>
          discussion.reopen(thread.id, { focus: true, inPlace: true })
        }
      >
        <span className="side-discussion-anchor">{label}</span>
        {notice && (
          <span className="selection-mini-outdated">{notice.label}</span>
        )}
      </button>
      {detached && thread.status.kind !== "unreadable" && (
        <pre
          className="side-discussion-code"
          aria-label="Original selected code"
        >
          {thread.git.original.code}
        </pre>
      )}
    </li>
  );
}

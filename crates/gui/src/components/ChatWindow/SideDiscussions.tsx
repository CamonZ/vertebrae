import { lazy, Suspense, useContext, useRef, type KeyboardEvent } from "react";
import type { PaletteItem } from "../CommandPalette/paletteModel";
import { contextScope, usePaletteScope } from "../CommandPalette/paletteScopes";
import { CHAT_AREA_ATTRIBUTE, enterFirstRow, stepRow } from "./chatAreas";
import { keyHintItem, type KeyHintArgs } from "./chatPaletteCommands";
import {
  DIFF_COPY_SHORTCUT,
  DISCUSSION_LIST_HINTS,
  DISCUSSION_LIST_KEYS,
  DISCUSSION_OPEN_KEY,
  matchesExactChatShortcut,
} from "./chatShortcuts";
import { QuoteGlyph } from "./commentIcons";
import { SideEmptyState } from "./SideEmptyState";
import { LockGlyph, MiniThread } from "./SelectionDiscussionThread";
import {
  anchorNotice,
  codeUnderDiscussion,
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
const ROW_SELECTOR = `[${ROW_ATTRIBUTE}]`;

const GROUP: Record<ThreadPlace, { title: string; description?: string }> = {
  detached: {
    title: "Detached",
    description: "The code changed or moved; the original selection is kept.",
  },
  changes: { title: "In Changes" },
  github: {
    title: "On GitHub threads",
    description: "Private; shown with the GitHub thread they discuss.",
  },
  transcript: {
    title: "In the transcript",
    description: "Anchored on a tool call's patch in the chat.",
  },
  document: {
    title: "In open files",
    description: "Anchored on a whole file opened from Changes.",
  },
};

function showsInChanges(place: ThreadPlace) {
  return place === "changes" || place === "github";
}

function copy(text: string) {
  navigator.clipboard.writeText(text).catch((error: unknown) => {
    console.error("Failed to copy original code", error);
  });
}

/** What a row's keys do; the palette offers the same for the focused row. */
function threadActions(thread: SelectionThread, discussion: DiscussionValue) {
  return {
    reply: () => discussion.reopen(thread.id, { focus: true, inPlace: true }),
    // Not in place: the thread opens at its anchor (or GitHub thread) in Changes.
    showCode: showsInChanges(threadPlace(thread))
      ? () => discussion.reopen(thread.id, { focus: true })
      : null,
    copy: () => copy(thread.git.original.code),
    /** Fold (true) or unfold (false); null when it already is. */
    fold: (folded: boolean) =>
      discussion.collapsed.has(thread.id) === folded
        ? null
        : () => discussion.toggleCollapsed(thread.id),
  };
}

/**
 * The Discussions scope: ↑/↓ between rows and, on a focused row, what its
 * keys do, each showing the key the ⌘⇧/ sheet lists.
 */
function discussionItems(
  list: HTMLElement,
  target: Element,
  discussion: DiscussionValue
): PaletteItem[] {
  const keyed = (...args: KeyHintArgs) => keyHintItem("discussions", ...args);
  // An inner control may hold focus; act on its row.
  const row = target.closest(ROW_SELECTOR);
  const move = DISCUSSION_LIST_KEYS.move;
  const items =
    list.querySelectorAll(ROW_SELECTOR).length > 1
      ? [
          keyed(
            "next",
            move,
            () => stepRow(list, ROW_SELECTOR, row, 1),
            "Next discussion"
          ),
          keyed(
            "previous",
            move,
            () => stepRow(list, ROW_SELECTOR, row, -1),
            "Previous discussion"
          ),
        ]
      : [];
  const id = row?.getAttribute(ROW_ATTRIBUTE);
  const thread = id ? discussion.threads.find((t) => t.id === id) : null;
  if (!thread) return items;
  const actions = threadActions(thread, discussion);
  const fold = actions.fold(true);
  const unfold = actions.fold(false);
  return [
    ...items,
    keyed("reply", DISCUSSION_LIST_KEYS.reply, actions.reply),
    ...(actions.showCode
      ? [keyed("code", DISCUSSION_LIST_KEYS.showCode, actions.showCode)]
      : []),
    keyed("copy", DISCUSSION_LIST_KEYS.copy, actions.copy),
    ...(fold
      ? [keyed("fold", DISCUSSION_LIST_KEYS.fold, fold, "Fold earlier turns")]
      : []),
    ...(unfold
      ? [
          keyed(
            "unfold",
            DISCUSSION_LIST_KEYS.fold,
            unfold,
            "Unfold earlier turns"
          ),
        ]
      : []),
  ].map((item) => ({ ...item, hint: selectionLabel(thread.anchor) }));
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
  usePaletteScope(listRef, (target) =>
    discussion && listRef.current
      ? [
          contextScope(
            "discussions",
            discussionItems(listRef.current, target, discussion)
          ),
        ]
      : []
  );
  if (!discussion) return null;
  const returnTo = (id: string) => focusRow(listRef.current, id);
  const groups = discussionList(discussion.threads);
  const empty = discussion.threads.length === 0;

  const onKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    if (event.defaultPrevented || event.nativeEvent.isComposing) return;
    const list = event.currentTarget;
    const target = event.target as HTMLElement;
    const plain =
      !event.metaKey && !event.ctrlKey && !event.altKey && !event.shiftKey;
    const step =
      event.key === "ArrowDown" ? 1 : event.key === "ArrowUp" ? -1 : 0;
    // From the section itself (⌘⌥→ lands here) the arrows enter the list.
    if (target === list) {
      if (!plain || !step || list.querySelectorAll(ROW_SELECTOR).length === 0)
        return;
      event.preventDefault();
      stepRow(list, ROW_SELECTOR, null, step);
      return;
    }
    const id = target.getAttribute(ROW_ATTRIBUTE);
    const thread = id ? discussion.threads.find((t) => t.id === id) : null;
    if (!thread) return;
    const actions = threadActions(thread, discussion);
    const run = (action: (() => void) | null) => {
      if (!action) return;
      event.preventDefault();
      action();
    };
    if (plain && step) run(() => stepRow(list, ROW_SELECTOR, target, step));
    else if (plain && event.key === "Enter") run(actions.reply);
    else if (plain && event.key.toLowerCase() === DISCUSSION_OPEN_KEY)
      run(actions.showCode);
    else if (matchesExactChatShortcut(event, DIFF_COPY_SHORTCUT))
      run(actions.copy);
    else if (plain && (event.key === "ArrowLeft" || event.key === "ArrowRight"))
      run(actions.fold(event.key === "ArrowLeft"));
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
        <SideEmptyState
          icon={<QuoteGlyph />}
          message="No discussions yet."
          hint={
            <>
              Select code in Changes and press{" "}
              <kbd className="chat-comment-kbd">c</kbd> to ask about it.
            </>
          }
        />
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
      {!empty && (
        <footer className="side-section-hints" aria-label="Discussions keys">
          {DISCUSSION_LIST_HINTS.map(({ keys, label }) => (
            <span key={label}>
              <kbd>{keys.join("")}</kbd> {label}
            </span>
          ))}
        </footer>
      )}
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

const DiscussedCodeView = lazy(() => import("./DiscussedCodeView"));

/**
 * Away from the diff, an opened discussion shows the code it is about,
 * highlighted as in Changes; one whose code changed shows its original
 * selection instead.
 */
function CodeUnderDiscussion({
  anchor,
}: {
  anchor: SelectionThread["anchor"];
}) {
  return (
    <div className="side-discussion-diff" aria-label="Code under discussion">
      <Suspense
        fallback={<pre className="side-discussion-code">{anchor.code}</pre>}
      >
        <DiscussedCodeView code={codeUnderDiscussion(anchor)} />
      </Suspense>
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
          code={
            thread.status.kind === "inline" && (
              <CodeUnderDiscussion anchor={thread.anchor} />
            )
          }
        />
      </li>
    );
  }
  const label = selectionLabel(thread.anchor);
  const github = place === "github";
  return (
    <li className="side-discussion" data-thread-id={thread.id}>
      <button
        type="button"
        className="side-discussion-row"
        data-private={github ? "" : undefined}
        {...{ [ROW_ATTRIBUTE]: thread.id }}
        aria-label={`${github ? "Private discussion of the GitHub thread" : "Discussion"} on ${label}${notice ? `, ${notice.label}` : ""}`}
        aria-keyshortcuts={
          showsInChanges(place)
            ? `Enter ${DISCUSSION_OPEN_KEY} Meta+C`
            : "Enter Meta+C"
        }
        title={
          showsInChanges(place)
            ? `Open discussion (↵) · show ${github ? "its thread " : ""}in Changes (o) · copy code (⌘C)`
            : `Open discussion (↵) · copy ${detached ? "original " : ""}code (⌘C)`
        }
        onClick={() =>
          discussion.reopen(thread.id, { focus: true, inPlace: true })
        }
      >
        {github && <LockGlyph />}
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

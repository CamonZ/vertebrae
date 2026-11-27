import type { WorktreeChange } from "../../../bindings";
import type { WorktreePr } from "../../../hooks/useWorktreePr";
import {
  isAbsoluteHttpUrl,
  openExternalUrl,
} from "../../../utils/openExternalUrl";
import { useChatStore } from "../../../stores/chatStore";
import { useCommandPaletteStore } from "../../../stores/commandPaletteStore";
import { focusedPaletteScopes } from "../../CommandPalette/paletteScopes";
import type { PaletteItem } from "../../CommandPalette/paletteModel";
import {
  CHANGES_COMMANDS,
  CHANGES_FILE_JUMP_KEYS,
  CHANGES_UNVIEW_HINT,
  CHANGES_VIEWED_KEY,
  DISCUSSION_ASK_SHORTCUT,
  DISCUSSION_COLLAPSE_SHORTCUT,
  DISCUSSION_OPEN_KEY,
  DISCUSSION_SEND_SHORTCUT,
  keyHintText,
  shortcutText,
} from "../chatShortcuts";
import type { DiscussionValue } from "../selectionDiscussionState";
import { isOutdated, selectionLabel } from "../selectionDiscussions";
import type { DiffStyle } from "./ComparisonControls";
import type { PrBarHandle } from "./PrAssociationBar";
import { STATUS_LETTER } from "./status";

const FILE_ITEM_PREFIX = "changes-file-";

/**
 * / finds a file: the palette on Changes with its files first, then the
 * chat's scopes. ⌘K needs nothing from Changes: the palette opens on the
 * focused section's scope by itself.
 */
export function openFilesPalette(origin: Element) {
  const isFile = (item: PaletteItem) => item.id.startsWith(FILE_ITEM_PREFIX);
  const { contexts } = focusedPaletteScopes(origin);
  useCommandPaletteStore.getState().openPalette(
    "changes",
    contexts.map((context) =>
      context.id === "changes"
        ? {
            ...context,
            items: [
              ...context.items.filter(isFile),
              ...context.items.filter((item) => !isFile(item)),
            ],
          }
        : context
    )
  );
}

/**
 * Discussions in the ⌘K palette, each with the binding that does the same
 * from the diff: every action on the open discussion, then every other
 * discussion to open.
 */
function changesDiscussionItems(
  discussion: DiscussionValue | null,
  refocus: () => void
): PaletteItem[] {
  if (!discussion) return [];
  // Full-file threads are opened from their document's own annotations.
  const threads = discussion.threads.filter(({ anchor }) => !anchor.fullFile);
  const active = threads.find(({ id }) => id === discussion.activeId);
  const activeItems: PaletteItem[] = [];
  if (active) {
    const hint = selectionLabel(active.anchor);
    const inline = active.status.kind === "inline";
    const readable = active.status.kind !== "unreadable";
    const item = (
      id: string,
      label: string,
      detail: string | undefined,
      keywords: string,
      run: () => void
    ): PaletteItem => ({
      id: `changes-discussion-${id}`,
      scope: "changes",
      label,
      hint,
      access: detail ? { key: detail } : "palette-only",
      keywords: `discussion ${keywords}`,
      run,
    });
    const session = active.sessionId
      ? useChatStore.getState().sessions[active.sessionId]
      : undefined;
    if (readable) {
      activeItems.push(
        item(
          "ask",
          "Ask follow-up",
          shortcutText(DISCUSSION_ASK_SHORTCUT),
          "question composer",
          () => discussion.reopen(active.id, { focus: true })
        ),
        item(
          "send",
          "Send selection to main chat",
          shortcutText(DISCUSSION_SEND_SHORTCUT),
          "attach",
          () => discussion.attach(active.anchor, isOutdated(active))
        )
      );
    }
    if (session?.activeTurn) {
      activeItems.push(
        item("stop", "Stop response", undefined, "cancel", () =>
          discussion.cancel(active.id)
        )
      );
    }
    activeItems.push(
      item(
        "collapse",
        discussion.collapsed.has(active.id)
          ? "Show all turns"
          : "Show only the latest response",
        shortcutText(DISCUSSION_COLLAPSE_SHORTCUT),
        "collapse expand earlier turns",
        () => discussion.toggleCollapsed(active.id)
      )
    );
    if (inline) {
      activeItems.push(
        item(
          "highlight",
          "Highlight selected code",
          undefined,
          "select anchor",
          () => discussion.select(active.anchor)
        )
      );
    }
    activeItems.push(
      item("close", "Close discussion", "Esc", "", () => {
        discussion.reopen(null);
        refocus();
      })
    );
  }
  const openItems: PaletteItem[] = threads
    .filter(({ id }) => id !== discussion.activeId)
    .map((thread) => ({
      id: `changes-discussion-open-${thread.id}`,
      scope: "changes",
      label: "Open discussion",
      hint: selectionLabel(thread.anchor),
      // `o` works on the anchor's line, which only an inline thread has.
      access:
        thread.status.kind === "inline"
          ? { key: DISCUSSION_OPEN_KEY }
          : "palette-only",
      keywords: "discussion reopen thread",
      run: () => discussion.reopen(thread.id, { focus: true }),
    }));
  return [...activeItems, ...openItems];
}

/** What Changes shows, for its palette entries. */
export interface ChangesPaletteState {
  files: readonly WorktreeChange[];
  selectedPath: string | null;
  viewedPaths: ReadonlySet<string>;
  filesOpen: boolean;
  diffStyle: DiffStyle;
  discussion: DiscussionValue | null;
  /** The comparison selects' triggers, opened by their entries. */
  baseButton: HTMLButtonElement | null;
  targetButton: HTMLButtonElement | null;
  /** The chat branch's PR, when Changes shows its review bar. */
  pr: WorktreePr | null;
  prBar: PrBarHandle | null;
}

/** What Changes does for its palette entries. */
export interface ChangesPaletteActions {
  jumpToFile(path: string, focusHeader: boolean): void;
  moveFile(direction: -1 | 1): void;
  setViewed(path: string, viewed: boolean): void;
  focusFileList(): void;
  hideFiles(): void;
  openSelected(view: "file" | "diff"): void;
  openExternal(): void;
  setDiffStyle(style: DiffStyle): void;
  refresh(): void;
  /** Return focus to Changes; entering resumes the line cursor. */
  refocus(): void;
}

/** Changes commands, its discussions and files, in the ⌘K Changes scope. */
export function changesPaletteItems(
  state: ChangesPaletteState,
  actions: ChangesPaletteActions
): PaletteItem[] {
  const { files, selectedPath, viewedPaths } = state;
  const { refocus } = actions;
  const pick = (button: HTMLButtonElement | null) => () => {
    requestAnimationFrame(() => {
      button?.focus();
      button?.click();
    });
  };
  const fileItems: PaletteItem[] = files.map((file) => ({
    id: `${FILE_ITEM_PREFIX}${file.path}`,
    scope: "changes",
    label: file.path,
    hint: viewedPaths.has(file.path) ? "Viewed" : undefined,
    detail: STATUS_LETTER[file.status],
    keywords: "file go to jump",
    run: () => actions.jumpToFile(file.path, true),
  }));
  const viewedItems: PaletteItem[] = [...viewedPaths]
    .reverse()
    .map((path, index) => ({
      id: `changes-unview-${path}`,
      scope: "changes",
      label: "Unmark file viewed",
      hint: path,
      // ⇧V unmarks the most recently viewed file, which is listed first.
      access:
        index === 0
          ? { key: keyHintText(CHANGES_UNVIEW_HINT) }
          : "palette-only",
      keywords: "unviewed reviewed undo show",
      run: () => {
        actions.setViewed(path, false);
        actions.jumpToFile(path, true);
      },
    }));
  const unviewAll: PaletteItem[] =
    viewedPaths.size > 1
      ? [
          {
            id: "changes-unview-all",
            scope: "changes",
            label: "Unmark all viewed files",
            hint: `${viewedPaths.size} files`,
            access: "palette-only",
            keywords: "unviewed reviewed reset clear",
            run: () => {
              for (const path of viewedPaths) actions.setViewed(path, false);
              refocus();
            },
          },
        ]
      : [];
  const fileJumps: PaletteItem[] =
    files.length > 1
      ? (["next", "previous"] as const).map((direction) => ({
          id: `changes-jump-${direction}`,
          scope: "changes",
          label: CHANGES_FILE_JUMP_KEYS[direction].label,
          access: { key: keyHintText(CHANGES_FILE_JUMP_KEYS[direction]) },
          keywords: "go to heading",
          run: () => actions.moveFile(direction === "next" ? 1 : -1),
        }))
      : [];
  const selectedItems: PaletteItem[] = selectedPath
    ? [
        {
          id: "changes-diff",
          scope: "changes",
          label: CHANGES_COMMANDS.diff,
          hint: selectedPath,
          access: "palette-only",
          run: () => actions.openSelected("diff"),
        },
        {
          id: "changes-file",
          scope: "changes",
          label: CHANGES_COMMANDS.file,
          hint: selectedPath,
          access: "palette-only",
          run: () => actions.openSelected("file"),
        },
        {
          id: "changes-external",
          scope: "changes",
          label: CHANGES_COMMANDS.external,
          hint: selectedPath,
          access: "palette-only",
          run: actions.openExternal,
        },
        // A viewed file's unmark entry is listed with the others below.
        ...(viewedPaths.has(selectedPath)
          ? []
          : [
              {
                id: "changes-viewed",
                scope: "changes",
                label: "Mark file viewed",
                hint: selectedPath,
                access: { key: CHANGES_VIEWED_KEY },
                keywords: "reviewed done",
                run: () => {
                  actions.setViewed(selectedPath, true);
                  refocus();
                },
              } satisfies PaletteItem,
            ]),
      ]
    : [];
  const commands: PaletteItem[] = [
    {
      id: "changes-base",
      scope: "changes",
      label: CHANGES_COMMANDS.base,
      access: "palette-only",
      keywords: "comparison branch",
      run: pick(state.baseButton),
    },
    {
      id: "changes-target",
      scope: "changes",
      label: CHANGES_COMMANDS.target,
      access: "palette-only",
      keywords: "comparison head branch worktree",
      run: pick(state.targetButton),
    },
    {
      id: "changes-files",
      scope: "changes",
      label: CHANGES_COMMANDS.files,
      access: "palette-only",
      keywords: "sidebar list explorer open",
      run: () => void requestAnimationFrame(actions.focusFileList),
    },
    ...(state.filesOpen
      ? [
          {
            id: "changes-hide-files",
            scope: "changes",
            label: CHANGES_COMMANDS.hideFiles,
            access: "palette-only",
            keywords: "sidebar list explorer collapse close toggle",
            run: () => {
              actions.hideFiles();
              refocus();
            },
          } satisfies PaletteItem,
        ]
      : []),
    ...fileJumps,
    ...selectedItems,
    ...viewedItems,
    ...unviewAll,
    {
      id: "changes-layout",
      scope: "changes",
      label:
        state.diffStyle === "split"
          ? CHANGES_COMMANDS.unified
          : CHANGES_COMMANDS.split,
      access: "palette-only",
      keywords: "diff layout view",
      run: () => {
        actions.setDiffStyle(state.diffStyle === "split" ? "unified" : "split");
        refocus();
      },
    },
    {
      id: "changes-refresh",
      scope: "changes",
      label: CHANGES_COMMANDS.refresh,
      access: "palette-only",
      keywords: "reload",
      run: () => {
        actions.refresh();
        refocus();
      },
    },
  ];
  return [
    ...commands,
    ...prItems(state.pr, state.prBar, refocus),
    ...changesDiscussionItems(state.discussion, refocus),
    ...fileItems,
  ];
}

/** The review bar's actions: its checks, a refresh, the PR on GitHub, linking. */
function prItems(
  pr: WorktreePr | null,
  bar: PrBarHandle | null,
  refocus: () => void
): PaletteItem[] {
  const association = pr?.association;
  if (!pr || !bar || !association) return [];
  const linked = association.status === "linked" ? association : null;
  const hint = linked ? `#${linked.pr.number}` : undefined;
  const item = (
    id: string,
    label: string,
    keywords: string,
    run: () => void
  ): PaletteItem => ({
    id: `changes-pr-${id}`,
    scope: "changes",
    label,
    hint,
    access: "palette-only",
    keywords: `pull request github ${keywords}`,
    run,
  });
  const items: PaletteItem[] = [];
  if (bar.checksOpen !== null)
    items.push(
      item(
        "checks",
        bar.checksOpen
          ? CHANGES_COMMANDS.hideChecks
          : CHANGES_COMMANDS.showChecks,
        "ci checks drawer",
        bar.toggleChecks
      )
    );
  if (!pr.busy && !linked?.readOnly && association.status !== "not_applicable")
    items.push(
      item("refresh", CHANGES_COMMANDS.refreshPr, "reload check again", () => {
        void pr.refresh();
        refocus();
      })
    );
  if (linked && isAbsoluteHttpUrl(linked.pr.url))
    items.push(
      item("open", CHANGES_COMMANDS.openPr, "browser external", () => {
        openExternalUrl(linked.pr.url);
        refocus();
      })
    );
  if (bar.openLink)
    items.push(
      item(
        "link",
        CHANGES_COMMANDS.linkPr,
        "associate number url",
        bar.openLink
      )
    );
  if (linked && !linked.readOnly && !pr.busy)
    items.push(
      item("unlink", CHANGES_COMMANDS.unlinkPr, "remove detach", () => {
        void pr.unlinkPr();
        refocus();
      })
    );
  return items;
}

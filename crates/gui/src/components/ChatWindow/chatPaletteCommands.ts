/**
 * The chat workspace's ⌘K scopes (decision 49d12c2c §4.1): every workspace
 * action is a key where focus is, a palette entry in the focused area's
 * scope, or both. Entries come from the same `ChatShortcutDefinition`s as
 * the dispatcher, tooltips and the ⌘⇧/ sheet, so their keys cannot drift.
 */
import { createContext, useContext, type RefObject } from "react";
import type { ShortcutDispatchState } from "../../hooks/useChatKeyboardShortcuts";
import type { useChatSession } from "../../hooks/useChatSession";
import { useEntityPanelStore } from "../../stores/entityPanelStore";
import { permissionModeOptions } from "./permissionModeOptions";
import {
  SIDE_SECTIONS,
  type SideSection,
} from "../../stores/chatSideColumnStore";
import type {
  ContextScopeId,
  PaletteItem,
} from "../CommandPalette/paletteModel";
import {
  contextScope,
  usePaletteScope,
  type PaletteContextScope,
} from "../CommandPalette/paletteScopes";
import { CHAT_AREA_ATTRIBUTE } from "./chatAreas";
import {
  CHAT_FIND_SHORTCUT,
  CHAT_HELP_SHORTCUT,
  CHAT_HISTORY_SHORTCUT,
  SIDE_COLUMN_SHORTCUTS,
  STOP_GENERATION_SHORTCUT,
  WORKSPACE_SHORTCUTS,
  keyHintText,
  shortcutText,
  type ChatShortcutDefinition,
} from "./chatShortcuts";

/** A palette entry that does what `shortcut` does, showing its key. */
function shortcutItem(
  scope: ContextScopeId,
  id: string,
  shortcut: ChatShortcutDefinition,
  run: () => unknown
): PaletteItem {
  return {
    id: `${scope}-${id}`,
    scope,
    label: shortcut.label,
    access: { key: shortcutText(shortcut) },
    run: () => void run(),
  };
}

/** A palette entry for a list key, showing the key the ⌘⇧/ sheet lists. */
export function keyHintItem(
  scope: ContextScopeId,
  id: string,
  hint: { keys: readonly string[]; label: string },
  run: () => void,
  label = hint.label
): PaletteItem {
  return {
    id: `${scope}-${id}`,
    scope,
    label,
    access: { key: keyHintText(hint) },
    run,
  };
}

/** `keyHintItem`'s arguments after the scope. */
export type KeyHintArgs =
  Parameters<typeof keyHintItem> extends [ContextScopeId, ...infer Rest]
    ? Rest
    : never;

/** An action no key reaches, marked so in the palette. */
function paletteOnlyItem(
  scope: ContextScopeId,
  id: string,
  label: string,
  run: () => unknown,
  extra: Pick<PaletteItem, "hint" | "keywords"> = {}
): PaletteItem {
  return {
    id: `${scope}-${id}`,
    scope,
    label,
    access: "palette-only",
    ...extra,
    run: () => void run(),
  };
}

/** What the workspace (ChatWindowManager) does for the palette. */
export type WorkspaceCommands = Pick<
  ShortcutDispatchState,
  | "toggleExpanded"
  | "focusPaneByOffset"
  | "focusNeedingYou"
  | "moveActivePane"
  | "openFreshChat"
  | "closeActivePane"
  | "openPaneFind"
  | "toggleHistoryVisibility"
  | "toggleSideColumn"
  | "toggleSideSection"
> & { openShortcutSheet(): void };

/** The side column's entries, offered in This chat and in each section. */
function sideColumnItems(
  scope: ContextScopeId,
  commands: Pick<WorkspaceCommands, "toggleSideColumn" | "toggleSideSection">
): PaletteItem[] {
  return [
    shortcutItem(scope, "side-toggle", SIDE_COLUMN_SHORTCUTS.toggle, () =>
      commands.toggleSideColumn()
    ),
    ...SIDE_SECTIONS.map((section) =>
      shortcutItem(
        scope,
        `side-${section}`,
        SIDE_COLUMN_SHORTCUTS[section],
        () => commands.toggleSideSection(section)
      )
    ),
  ];
}

/** This chat's workspace entries, in the order of the decision's table. */
export function workspaceChatItems(commands: WorkspaceCommands): PaletteItem[] {
  const item = (
    id: string,
    shortcut: ChatShortcutDefinition,
    run: () => unknown
  ) => shortcutItem("chat", id, shortcut, run);
  return [
    ...sideColumnItems("chat", commands),
    item("next-tab", WORKSPACE_SHORTCUTS.nextChatTab, () =>
      commands.focusPaneByOffset(1)
    ),
    item("previous-tab", WORKSPACE_SHORTCUTS.previousChatTab, () =>
      commands.focusPaneByOffset(-1)
    ),
    item("next-needing-you", WORKSPACE_SHORTCUTS.nextNeedingYou, () =>
      commands.focusNeedingYou(1)
    ),
    item("previous-needing-you", WORKSPACE_SHORTCUTS.previousNeedingYou, () =>
      commands.focusNeedingYou(-1)
    ),
    item("expand", WORKSPACE_SHORTCUTS.toggleExpanded, () =>
      commands.toggleExpanded()
    ),
    item("move-left", WORKSPACE_SHORTCUTS.moveChatLeft, () =>
      commands.moveActivePane(-1)
    ),
    item("move-right", WORKSPACE_SHORTCUTS.moveChatRight, () =>
      commands.moveActivePane(1)
    ),
    item("fresh", WORKSPACE_SHORTCUTS.freshChat, () =>
      commands.openFreshChat()
    ),
    item("close", WORKSPACE_SHORTCUTS.closeChat, () =>
      commands.closeActivePane()
    ),
    item("find", CHAT_FIND_SHORTCUT, () => commands.openPaneFind()),
    item("history", CHAT_HISTORY_SHORTCUT, () =>
      commands.toggleHistoryVisibility()
    ),
    item("shortcuts", CHAT_HELP_SHORTCUT, () => commands.openShortcutSheet()),
  ];
}

/**
 * The workspace's commands for the chats inside it; read when ⌘K opens, so
 * the getter returns the latest handlers.
 */
export const WorkspaceCommandsContext = createContext<
  (() => WorkspaceCommands) | null
>(null);

function focusedSection(target: Element): SideSection | null {
  const area = target
    .closest(`[${CHAT_AREA_ATTRIBUTE}]`)
    ?.getAttribute(CHAT_AREA_ATTRIBUTE);
  return SIDE_SECTIONS.find((section) => section === area) ?? null;
}

/**
 * Offer This chat (the workspace entries, then `paneItems`: the chat's own
 * actions) while focus is in the chat at `ref`, and the side column entries
 * in the focused section's scope after that section's own entries.
 */
export function useChatPaletteScope(
  ref: RefObject<HTMLElement | null>,
  paneItems: () => readonly PaletteItem[]
) {
  const workspace = useContext(WorkspaceCommandsContext);
  usePaletteScope(ref, (target): PaletteContextScope[] => {
    const commands = workspace?.();
    const section = focusedSection(target);
    return [
      ...(section && commands
        ? [contextScope(section, sideColumnItems(section, commands))]
        : []),
      contextScope("chat", [
        ...(commands ? workspaceChatItems(commands) : []),
        ...paneItems(),
      ]),
    ];
  });
}

export interface ChatPaneCommands {
  /** ⌘. stops the turn; offered only while one can stop. */
  stop: (() => void) | null;
  permissionModes: readonly { value: string; label: string }[];
  permissionMode: string;
  setPermissionMode(value: string): void;
  /** Opens the composer's model settings; null when the chat has none. */
  openModelSettings: (() => void) | null;
  linkedTicket: { id: string; title: string | null } | null;
  openTicket(id: string): void;
  clearMessages(): void;
}

/** This chat's own entries, after the workspace ones. */
export function chatPaneItems(commands: ChatPaneCommands): PaletteItem[] {
  const { stop, linkedTicket, openModelSettings } = commands;
  return [
    ...(stop
      ? [shortcutItem("chat", "stop", STOP_GENERATION_SHORTCUT, stop)]
      : []),
    ...commands.permissionModes
      .filter((mode) => mode.value !== commands.permissionMode)
      .map((mode) =>
        paletteOnlyItem(
          "chat",
          `permission-${mode.value}`,
          `Permission mode: ${mode.label}`,
          () => commands.setPermissionMode(mode.value),
          { keywords: "permissions approve bypass" }
        )
      ),
    ...(openModelSettings
      ? [
          paletteOnlyItem("chat", "model", "Change model…", openModelSettings, {
            keywords: "provider effort speed settings",
          }),
        ]
      : []),
    ...(linkedTicket
      ? [
          paletteOnlyItem(
            "chat",
            "ticket",
            "Open linked ticket",
            () => commands.openTicket(linkedTicket.id),
            {
              hint: linkedTicket.title ?? linkedTicket.id.slice(0, 8),
              keywords: `task ${linkedTicket.id}`,
            }
          ),
        ]
      : []),
    paletteOnlyItem("chat", "clear", "Clear messages", commands.clearMessages, {
      keywords: "reset transcript",
    }),
  ];
}

/**
 * This chat's scope for a ChatWindow whose root is `ref`: the workspace
 * entries plus the chat's own (stop, permission mode, model, linked
 * ticket, clear messages).
 */
export function useChatWindowPalette(
  ref: RefObject<HTMLElement | null>,
  chat: ReturnType<typeof useChatSession>,
  association: { ticketId: string | null; ticketTitle: string | null } | null,
  openModelSettings: RefObject<(() => void) | null>
) {
  const openTask = useEntityPanelStore((state) => state.openTask);
  useChatPaletteScope(ref, () => {
    const session = chat.session;
    if (!session) return [];
    const ticketId = association?.ticketId;
    return chatPaneItems({
      stop: chat.canStopGeneration
        ? () => void chat.handleStopGeneration()
        : null,
      permissionModes: permissionModeOptions(
        session.harness,
        chat.visibleHarness?.permission_modes
      ),
      permissionMode: session.permissionMode ?? "default",
      setPermissionMode: chat.handlePermissionModeChange,
      openModelSettings: openModelSettings.current,
      linkedTicket: ticketId
        ? { id: ticketId, title: association?.ticketTitle ?? null }
        : null,
      openTicket: openTask,
      clearMessages: () => void chat.handleClearMessages(),
    });
  });
}

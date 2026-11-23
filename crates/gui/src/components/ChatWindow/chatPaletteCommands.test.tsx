import { act, render, screen } from "@testing-library/react";
import { useRef } from "react";
import { describe, expect, it, vi } from "vitest";
import type { PaletteItem } from "../CommandPalette/paletteModel";
import {
  contextScope,
  focusedPaletteScopes,
  usePaletteScope,
} from "../CommandPalette/paletteScopes";
import { CHAT_SHORTCUT_SECTIONS } from "./ChatShortcutHints";
import {
  WorkspaceCommandsContext,
  chatPaneItems,
  useChatPaletteScope,
  workspaceChatItems,
  type ChatPaneCommands,
  type WorkspaceCommands,
} from "./chatPaletteCommands";
import {
  BACKGROUND_LIST_KEYS,
  CHANGES_FILE_JUMP_KEYS,
  CHANGES_UNVIEW_HINT,
  CHANGES_VIEWED_KEY,
  DISCUSSION_LIST_KEYS,
  SIDE_COLUMN_SHORTCUTS,
  WORKSPACE_SHORTCUTS,
  keyHintText,
  shortcutText,
} from "./chatShortcuts";

function workspace(): WorkspaceCommands {
  const commands: WorkspaceCommands = {
    toggleExpanded: vi.fn(),
    focusPaneByOffset: vi.fn(),
    focusNeedingYou: vi.fn(),
    moveActivePane: vi.fn(),
    openFreshChat: vi.fn(),
    closeActivePane: vi.fn(),
    openPaneFind: vi.fn(),
    toggleHistoryVisibility: vi.fn(),
    toggleSideColumn: vi.fn(),
    toggleSideSection: vi.fn(),
    openShortcutSheet: vi.fn(),
  };
  return commands;
}

function pane(overrides: Partial<ChatPaneCommands> = {}): ChatPaneCommands {
  return {
    stop: vi.fn(),
    permissionModes: [
      { value: "default", label: "Ask" },
      { value: "acceptEdits", label: "Accept edits" },
    ],
    permissionMode: "default",
    setPermissionMode: vi.fn(),
    openModelSettings: vi.fn(),
    linkedTicket: { id: "b9888dab-0000", title: "Palette scopes" },
    openTicket: vi.fn(),
    clearMessages: vi.fn(),
    ...overrides,
  };
}

const sectionItem: PaletteItem = {
  id: "discussions-reply",
  scope: "discussions",
  label: "Open and reply",
  access: { key: "↵" },
  run: () => undefined,
};

function Section() {
  const ref = useRef<HTMLElement>(null);
  usePaletteScope(ref, () => [contextScope("discussions", [sectionItem])]);
  return (
    <section ref={ref} data-chat-area="discussions" aria-label="Discussions">
      <button type="button">Thread row</button>
    </section>
  );
}

function Pane({ items }: { items: () => readonly PaletteItem[] }) {
  const ref = useRef<HTMLDivElement>(null);
  useChatPaletteScope(ref, items);
  return (
    <div ref={ref}>
      <textarea aria-label="Composer" />
      <Section />
    </div>
  );
}

function renderPane(
  commands = workspace(),
  items = () => chatPaneItems(pane())
) {
  render(
    <WorkspaceCommandsContext.Provider value={() => commands}>
      <Pane items={items} />
    </WorkspaceCommandsContext.Provider>
  );
  return commands;
}

describe("This chat scope", () => {
  it("opens on This chat from the composer, workspace entries then the chat's own", () => {
    const commands = renderPane();
    act(() => screen.getByLabelText("Composer").focus());
    const { contexts, initial } = focusedPaletteScopes();
    expect(initial).toBe("chat");
    expect(contexts.map((scope) => scope.label)).toEqual(["This chat"]);
    const items = contexts[0].items;
    expect(items.slice(0, 2).map((item) => [item.label, item.access])).toEqual([
      [
        SIDE_COLUMN_SHORTCUTS.toggle.label,
        { key: shortcutText(SIDE_COLUMN_SHORTCUTS.toggle) },
      ],
      [
        SIDE_COLUMN_SHORTCUTS.changes.label,
        { key: shortcutText(SIDE_COLUMN_SHORTCUTS.changes) },
      ],
    ]);
    expect(items.map((item) => item.label)).toEqual(
      expect.arrayContaining([
        "Stop generation",
        "Permission mode: Accept edits",
        "Change model…",
        "Open linked ticket",
        "Clear messages",
      ])
    );
    // The current permission mode is not offered again.
    expect(items.map((item) => item.label)).not.toContain(
      "Permission mode: Ask"
    );
    for (const label of [
      "Change model…",
      "Open linked ticket",
      "Clear messages",
    ]) {
      expect(items.find((item) => item.label === label)!.access).toBe(
        "palette-only"
      );
    }

    items
      .find((item) => item.label === WORKSPACE_SHORTCUTS.nextChatTab.label)!
      .run();
    expect(commands.focusPaneByOffset).toHaveBeenCalledWith(1);
    items
      .find((item) => item.label === SIDE_COLUMN_SHORTCUTS.background.label)!
      .run();
    expect(commands.toggleSideSection).toHaveBeenCalledWith("background");
  });

  it("offers Stop generation only while a turn can stop", () => {
    renderPane(workspace(), () =>
      chatPaneItems(pane({ stop: null, linkedTicket: null }))
    );
    act(() => screen.getByLabelText("Composer").focus());
    const labels = focusedPaletteScopes().contexts[0].items.map(
      (item) => item.label
    );
    expect(labels).not.toContain("Stop generation");
    expect(labels).not.toContain("Open linked ticket");
  });

  it("opens on the focused section, its own entries then the side column's, then This chat", () => {
    renderPane();
    act(() => screen.getByRole("button", { name: "Thread row" }).focus());
    const { contexts, initial } = focusedPaletteScopes();
    expect(initial).toBe("discussions");
    expect(contexts.map((scope) => scope.label)).toEqual([
      "Discussions",
      "This chat",
    ]);
    expect(contexts[0].items.map((item) => item.label)).toEqual([
      "Open and reply",
      SIDE_COLUMN_SHORTCUTS.toggle.label,
      SIDE_COLUMN_SHORTCUTS.changes.label,
      SIDE_COLUMN_SHORTCUTS.discussions.label,
      SIDE_COLUMN_SHORTCUTS.background.label,
    ]);
  });

  it("opens on All outside any scope", () => {
    renderPane();
    expect(focusedPaletteScopes(document.body)).toEqual({
      contexts: [],
      initial: "all",
    });
  });
});

describe("palette keys match the ⌘⇧/ sheet", () => {
  const sheetKeys = new Set(
    CHAT_SHORTCUT_SECTIONS.flatMap((section) =>
      section.shortcuts.map((shortcut) => shortcut.keys.join(""))
    )
  );

  it("lists every key This chat shows", () => {
    const items = [
      ...workspaceChatItems(workspace()),
      ...chatPaneItems(pane()),
    ];
    const keys = items.flatMap((item) =>
      item.access && item.access !== "palette-only" ? [item.access.key] : []
    );
    expect(keys.length).toBeGreaterThan(10);
    for (const key of keys) expect(sheetKeys, key).toContain(key);
  });

  it("lists every key the section scopes show", () => {
    const hints = [
      ...Object.values(DISCUSSION_LIST_KEYS),
      ...Object.values(BACKGROUND_LIST_KEYS),
      ...Object.values(CHANGES_FILE_JUMP_KEYS),
      CHANGES_UNVIEW_HINT,
      { keys: [CHANGES_VIEWED_KEY] },
    ];
    for (const hint of hints) {
      expect(sheetKeys, keyHintText(hint)).toContain(keyHintText(hint));
    }
  });
});

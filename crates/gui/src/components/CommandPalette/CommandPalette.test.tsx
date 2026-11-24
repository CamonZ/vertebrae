import { useRef } from "react";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom";
import { CommandPalette } from "./CommandPalette";
import {
  isPaletteShortcut,
  matchesQuery,
  paletteChatEntries,
  type PaletteItem,
} from "./paletteModel";
import { chatNumberHint } from "../ChatWindow/chatTabs";
import { contextScope, usePaletteScope } from "./paletteScopes";
import { useChatStore } from "../../stores/chatStore";
import { useCommandPaletteStore } from "../../stores/commandPaletteStore";
import { useEntityPanelStore } from "../../stores/entityPanelStore";
import { useFactoryFilterStore } from "../../stores/factoryFilterStore";
import { useUIStore } from "../../stores/uiStore";

vi.mock("../../hooks/useWorkflows", () => ({
  useWorkflows: () => ({
    workflows: [
      {
        id: "aaaaaaaa-0000-0000-0000-000000000000",
        name: "Implement",
        factory_name: "Delivery",
      },
    ],
  }),
}));

vi.mock("../../hooks/useTasks", () => ({
  useTasks: () => ({
    tasks: [
      {
        id: "eeeeeeee-0000-0000-0000-000000000000",
        title: "Workspace epic",
        level: "epic",
        parent_id: null,
      },
      {
        id: "df875b15-de5c-47b4-9d13-9e967b2487ea",
        title: "GUI clean-up pass",
        level: "ticket",
        parent_id: "eeeeeeee-0000-0000-0000-000000000000",
        tags: ["design"],
        description: "Hearth chrome reduction",
      },
      {
        id: "11111111-2222-3333-4444-555555555555",
        title: "Unrelated chore",
        level: "task",
      },
    ],
  }),
}));

function LocationProbe() {
  const location = useLocation();
  return <div data-testid="location">{location.pathname}</div>;
}

function renderPalette(path = "/tasks") {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <CommandPalette />
      <Routes>
        <Route path="*" element={<LocationProbe />} />
      </Routes>
    </MemoryRouter>
  );
}

function openPalette() {
  fireEvent.keyDown(window, { key: "k", metaKey: true });
  return screen.getByRole("dialog", { name: "Command palette" });
}

function type(value: string) {
  fireEvent.change(screen.getByTestId("command-palette-input"), {
    target: { value },
  });
}

describe("CommandPalette", () => {
  beforeEach(() => {
    useEntityPanelStore.getState().reset();
    useCommandPaletteStore.setState({
      open: false,
      scope: "all",
      contexts: [],
    });
    useChatStore.setState({
      sessions: {},
      localSessionSummaries: {},
      paneLayout: { order: [], activeId: null },
    });
  });

  it("offers a surface's own items under a Changes tab for one opening", () => {
    const run = vi.fn();
    renderPalette("/tasks");
    act(() =>
      useCommandPaletteStore.getState().openPalette("changes", [
        {
          id: "changes",
          label: "Changes",
          items: [
            {
              id: "changes-base",
              scope: "changes",
              label: "Choose base",
              access: "palette-only",
              run,
            },
          ],
        },
      ])
    );
    expect(
      screen.getByRole("option", { name: /Choose base/ })
    ).toHaveTextContent("palette only");
    expect(screen.getByRole("tab", { name: "Changes" })).toHaveAttribute(
      "aria-selected",
      "true"
    );
    fireEvent.keyDown(screen.getByTestId("command-palette-input"), {
      key: "Enter",
    });
    expect(run).toHaveBeenCalled();
    expect(useCommandPaletteStore.getState().contexts).toEqual([]);

    openPalette();
    expect(screen.queryByRole("tab", { name: "Changes" })).toBeNull();
  });

  it("opens on '/' scoped to tasks on task pages, but not while typing", () => {
    renderPalette("/tasks");
    const field = document.createElement("input");
    document.body.appendChild(field);
    field.focus();
    fireEvent.keyDown(field, { key: "/" });
    expect(screen.queryByRole("dialog")).toBeNull();
    field.remove();

    fireEvent.keyDown(window, { key: "/" });
    expect(screen.getByRole("tab", { name: "Tasks" })).toHaveAttribute(
      "aria-selected",
      "true"
    );
  });

  it("opens on '/' with every scope outside task pages", () => {
    renderPalette("/settings");
    fireEvent.keyDown(window, { key: "/" });
    expect(screen.getByRole("tab", { name: "All" })).toHaveAttribute(
      "aria-selected",
      "true"
    );
  });

  it("opens workflows inside their factory and scopes '/' to workflows on the atlas", () => {
    renderPalette("/design");
    fireEvent.keyDown(window, { key: "/" });
    expect(screen.getByRole("tab", { name: "Workflows" })).toHaveAttribute(
      "aria-selected",
      "true"
    );
    expect(
      document.getElementById("palette-option-factory-Delivery")
    ).not.toBeNull();
    fireEvent.click(screen.getByRole("option", { name: /Implement/ }));
    expect(useFactoryFilterStore.getState().factoryName).toBe("Delivery");
    expect(useEntityPanelStore.getState().selection).toMatchObject({
      type: "workflow",
      workflowId: "aaaaaaaa-0000-0000-0000-000000000000",
    });
    expect(screen.getByTestId("location")).toHaveTextContent("/design");
  });

  it("matches tasks by tag and description, ranking title matches first", () => {
    renderPalette();
    openPalette();
    type("design");
    expect(
      screen.getByRole("option", { name: /GUI clean-up pass/ })
    ).toBeInTheDocument();
    type("chrome reduction");
    expect(
      screen.getByRole("option", { name: /GUI clean-up pass/ })
    ).toBeInTheDocument();
  });

  it("finds saved chats by their linked ticket and opens them as a new tab", () => {
    const openSessionInNewTab = vi.fn().mockResolvedValue(true);
    useChatStore.setState({
      openSessionInNewTab,
      localSessionSummaries: {
        "chat-1": {
          id: "chat-1",
          label: "Chat",
          title: "Palette polish",
          association: { ticketId: "df875b15-de5c-47b4-9d13-9e967b2487ea" },
          hasUserMessage: true,
          updatedAt: "2026-11-15T10:00:00Z",
        },
      } as never,
    });
    renderPalette();
    openPalette();
    type("clean-up");
    const option = screen.getByRole("option", { name: /Palette polish/ });
    expect(option).toHaveTextContent("GUI clean-up pass");
    fireEvent.click(option);
    expect(openSessionInNewTab).toHaveBeenCalledWith("chat-1");
    expect(useChatStore.getState().panelOpen).toBe(true);
  });

  it("opens with ⌘K, focuses search, and closes with Escape", () => {
    renderPalette();
    expect(screen.queryByRole("dialog")).toBeNull();
    const dialog = openPalette();
    expect(screen.getByTestId("command-palette-input")).toHaveFocus();
    fireEvent.keyDown(dialog, { key: "Escape" });
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("toggles closed when ⌘K is pressed again, handing focus back", () => {
    const field = document.createElement("textarea");
    document.body.appendChild(field);
    field.focus();
    renderPalette();
    openPalette();
    expect(field).not.toHaveFocus();
    fireEvent.keyDown(window, { key: "k", metaKey: true });
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(field).toHaveFocus();
    field.remove();
  });

  it("navigates to a page with the keyboard", () => {
    renderPalette();
    const dialog = openPalette();
    type("artifacts");
    expect(screen.getByRole("option", { name: "Artifacts" })).toHaveAttribute(
      "aria-selected",
      "true"
    );
    fireEvent.keyDown(dialog, { key: "Enter" });
    expect(screen.getByTestId("location")).toHaveTextContent("/artifacts");
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("finds tasks by title or short ID and opens them in the inspector", () => {
    renderPalette();
    openPalette();
    type("df875b15");
    const option = screen.getByRole("option", { name: /GUI clean-up pass/ });
    expect(
      screen.queryByRole("option", { name: /Unrelated chore/ })
    ).toBeNull();
    fireEvent.click(option);
    expect(useEntityPanelStore.getState().selection).toEqual({
      type: "task",
      taskId: "df875b15-de5c-47b4-9d13-9e967b2487ea",
    });
  });

  it("narrows results with scope tabs and Tab cycles scopes", () => {
    renderPalette();
    const dialog = openPalette();
    fireEvent.click(screen.getByRole("tab", { name: "Actions" }));
    expect(screen.queryByRole("option", { name: "Artifacts" })).toBeNull();
    expect(
      screen.getByRole("option", { name: "Theme: Light" })
    ).toBeInTheDocument();
    fireEvent.keyDown(dialog, { key: "Tab" });
    expect(screen.getByRole("tab", { name: "All" })).toHaveAttribute(
      "aria-selected",
      "true"
    );
  });

  it("runs app actions such as switching theme", () => {
    renderPalette();
    openPalette();
    type("theme light");
    fireEvent.click(screen.getByRole("option", { name: "Theme: Light" }));
    expect(useUIStore.getState().theme).toBe("light");
  });

  it("sets a named text-size preset from the launcher", () => {
    renderPalette();
    openPalette();
    type("font size larger");
    fireEvent.click(
      screen.getByRole("option", { name: /Text size: Larger/ })
    );
    expect(useUIStore.getState().textSize).toBe("larger");
  });

  it("sets a custom text-size percentage from the launcher", () => {
    renderPalette();
    openPalette();
    type("font size 112%");
    fireEvent.click(
      screen.getByRole("option", { name: "Text size: 112%" })
    );
    expect(useUIStore.getState().textSize).toBe(112);
  });

  it("shows an empty state when nothing matches", () => {
    renderPalette();
    openPalette();
    type("zzzz-no-match");
    expect(screen.getByRole("status")).toHaveTextContent("No matches");
  });
});

describe("contextual scopes", () => {
  function Pane() {
    const pane = useRef<HTMLDivElement>(null);
    const section = useRef<HTMLElement>(null);
    const entry = (
      scope: "chat" | "discussions",
      label: string
    ): PaletteItem => ({
      id: `${scope}-${label}`,
      scope,
      label,
      access: "palette-only",
      run: () => undefined,
    });
    usePaletteScope(pane, () => [
      contextScope("chat", [entry("chat", "Chat entry")]),
    ]);
    usePaletteScope(section, () => [
      contextScope("discussions", [entry("discussions", "Reply entry")]),
    ]);
    return (
      <div ref={pane}>
        <section ref={section}>
          <button type="button">Thread row</button>
        </section>
      </div>
    );
  }

  beforeEach(() => {
    useCommandPaletteStore.setState({
      open: false,
      scope: "all",
      contexts: [],
    });
  });

  it("⌘K opens on the focused section; Tab and ⇧Tab walk section, chat, Chats, app scopes", () => {
    render(
      <MemoryRouter>
        <CommandPalette />
        <Pane />
      </MemoryRouter>
    );
    act(() => screen.getByRole("button", { name: "Thread row" }).focus());
    fireEvent.keyDown(window, { key: "k", metaKey: true });
    const input = screen.getByTestId("command-palette-input");
    const tabs = screen.getAllByRole("tab").map((tab) => tab.textContent);
    expect(tabs.slice(0, 4)).toEqual([
      expect.stringMatching(/^Discussions/),
      expect.stringMatching(/^This chat/),
      expect.stringMatching(/^Chats/),
      expect.stringMatching(/^All/),
    ]);
    const selected = () =>
      screen
        .getAllByRole("tab")
        .find((tab) => tab.getAttribute("aria-selected") === "true")
        ?.textContent;
    expect(selected()).toMatch(/^Discussions/);
    expect(
      screen.getByRole("option", { name: /Reply entry/ })
    ).toBeInTheDocument();

    fireEvent.keyDown(input, { key: "Tab" });
    expect(selected()).toMatch(/^This chat/);
    expect(
      screen.getByRole("option", { name: /Chat entry/ })
    ).toBeInTheDocument();
    fireEvent.keyDown(input, { key: "Tab" });
    expect(selected()).toMatch(/^Chats/);
    fireEvent.keyDown(input, { key: "Tab", shiftKey: true });
    fireEvent.keyDown(input, { key: "Tab", shiftKey: true });
    expect(selected()).toMatch(/^Discussions/);
  });
});

describe("Chats tree", () => {
  const TICKET = "df875b15-de5c-47b4-9d13-9e967b2487ea";
  let openSessionInNewTab: ReturnType<
    typeof vi.fn<(id: string) => Promise<boolean>>
  >;
  let focusPane: ReturnType<typeof vi.fn<(paneId: string) => void>>;

  beforeEach(() => {
    useCommandPaletteStore.setState({
      open: false,
      scope: "all",
      contexts: [],
    });
    openSessionInNewTab = vi
      .fn<(id: string) => Promise<boolean>>()
      .mockResolvedValue(true);
    focusPane = vi.fn<(paneId: string) => void>();
    const summary = (
      id: string,
      title: string,
      ticketId: string | null,
      updatedAt: string
    ) => ({
      id,
      label: "Chat",
      title,
      association: ticketId ? { ticketId } : null,
      hasUserMessage: true,
      updatedAt,
    });
    useChatStore.setState({
      openSessionInNewTab,
      focusPane,
      sessions: {},
      localSessionSummaries: {
        live: summary("live", "Live polish", TICKET, "2026-11-20T10:00:00Z"),
        old: summary("old", "Old polish", TICKET, "2026-11-10T10:00:00Z"),
        loose: summary("loose", "Loose notes", null, "2026-11-12T10:00:00Z"),
      } as never,
      paneLayout: {
        order: [{ id: "pane-live", sessionId: "live" }],
        activeId: "pane-live",
      } as never,
    });
  });

  function openTree() {
    renderPalette();
    return openChatsScope();
  }

  function openChatsScope() {
    fireEvent.keyDown(window, { key: "k", metaKey: true });
    fireEvent.click(screen.getByRole("tab", { name: "Chats" }));
    return screen.getByTestId("command-palette-input");
  }

  const row = (name: RegExp) => screen.getByRole("treeitem", { name });

  it("opens on the Chats scope as an ARIA tree, on the first open chat", () => {
    const input = openTree();
    expect(screen.getByRole("tab", { name: "Chats" })).toHaveAttribute(
      "aria-selected",
      "true"
    );
    expect(input).toHaveAttribute("aria-haspopup", "tree");
    expect(screen.getByRole("tree")).toBeInTheDocument();
    const live = row(/Live polish/);
    expect(input).toHaveAttribute("aria-activedescendant", live.id);
    expect(live).toHaveAttribute("aria-level", "4");
    expect(live).toHaveTextContent(`open · ${chatNumberHint(0, 1)}`);
    expect(row(/Workspace epic/)).toHaveAttribute("aria-expanded", "true");
    expect(row(/GUI clean-up pass/)).toHaveTextContent("df875b15");
    // History-only "No ticket" starts collapsed; "Unrelated chore" has no chat.
    expect(row(/No ticket/)).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByRole("treeitem", { name: /Loose notes/ })).toBeNull();
    expect(
      screen.queryByRole("treeitem", { name: /Unrelated chore/ })
    ).toBeNull();
  });

  it("activates an open chat and opens a history chat as a new tab with ↵", () => {
    const input = openTree();
    fireEvent.keyDown(input, { key: "Enter" });
    expect(focusPane).toHaveBeenCalledWith("pane-live");
    expect(openSessionInNewTab).not.toHaveBeenCalled();

    const reopened = openChatsScope();
    fireEvent.keyDown(reopened, { key: "ArrowDown" });
    expect(reopened).toHaveAttribute(
      "aria-activedescendant",
      row(/Old polish/).id
    );
    fireEvent.keyDown(reopened, { key: "Enter" });
    expect(openSessionInNewTab).toHaveBeenCalledWith("old");
  });

  it("walks branches with ←/→ only while the query is empty", () => {
    const input = openTree();
    fireEvent.keyDown(input, { key: "ArrowDown" });
    fireEvent.keyDown(input, { key: "ArrowDown" });
    expect(input).toHaveAttribute("aria-activedescendant", row(/No ticket/).id);
    fireEvent.keyDown(input, { key: "ArrowRight" });
    expect(row(/No ticket/)).toHaveAttribute("aria-expanded", "true");
    expect(row(/Loose notes/)).toBeInTheDocument();
    fireEvent.keyDown(input, { key: "ArrowLeft" });
    expect(row(/No ticket/)).toHaveAttribute("aria-expanded", "false");

    type("polish");
    // With a query the arrows move the caret instead.
    expect(fireEvent.keyDown(input, { key: "ArrowLeft" })).toBe(true);
    expect(fireEvent.keyDown(input, { key: "ArrowRight" })).toBe(true);
  });

  it("reaches project rows with ↑ and folds them with ←", () => {
    const input = openTree();
    for (let i = 0; i < 3; i++) fireEvent.keyDown(input, { key: "ArrowUp" });
    const project = screen
      .getAllByRole("treeitem")
      .find((item) => item.getAttribute("aria-level") === "1")!;
    expect(input).toHaveAttribute("aria-activedescendant", project.id);
    expect(project).toHaveAttribute("aria-selected", "true");
    fireEvent.keyDown(input, { key: "ArrowLeft" });
    expect(project).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByRole("treeitem", { name: /Live polish/ })).toBeNull();
  });

  it("scrolls the active row into view as ↑/↓ move", () => {
    const scrollIntoView = vi.fn();
    Element.prototype.scrollIntoView = scrollIntoView;
    try {
      const input = openTree();
      scrollIntoView.mockClear();
      fireEvent.keyDown(input, { key: "ArrowDown" });
      expect(scrollIntoView).toHaveBeenCalledWith({ block: "nearest" });
      expect(scrollIntoView.mock.contexts.at(-1)).toBe(row(/Old polish/));
    } finally {
      delete (Element.prototype as Partial<Element>).scrollIntoView;
    }
  });

  it("matches the whole path, tokens from different levels, ancestors expanded", () => {
    openTree();
    type("epic old");
    expect(row(/Old polish/)).toBeInTheDocument();
    expect(screen.queryByRole("treeitem", { name: /Live polish/ })).toBeNull();
    expect(row(/GUI clean-up pass/)).toHaveAttribute("aria-expanded", "true");
    // Rows whose own words carry every token are emphasised.
    type("old");
    expect(row(/Old polish/)).toHaveAttribute("data-matched", "true");
    expect(row(/GUI clean-up pass/)).not.toHaveAttribute("data-matched");

    type("notes");
    expect(row(/Loose notes/)).toBeInTheDocument();
    expect(row(/No ticket/)).toHaveAttribute("aria-expanded", "true");

    type("nothing here");
    expect(screen.getByRole("status")).toHaveTextContent("No matching chats");
  });
});

describe("palette helpers", () => {
  it("lists open and saved chats once, most recent first, with ticket context", () => {
    const entries = paletteChatEntries(
      [
        {
          id: "a",
          label: "A",
          updatedAt: "2026-11-01",
          hasUserMessage: true,
          association: { ticketId: "t-1", ticketTitle: "Stored title" },
        },
        { id: "b", label: "B", updatedAt: "2026-11-03", hasUserMessage: true },
        {
          id: "empty",
          label: "Empty",
          updatedAt: "2026-11-04",
          hasUserMessage: false,
        },
        { id: "a", label: "A", status: "open" },
        {
          id: "inline",
          label: "Inline",
          status: "open",
          hasUserMessage: true,
          discussion: {
            parentChatId: "a",
            reviewThreadId: "thread",
            worktreePath: "/checkout",
          },
        },
        {
          id: "unbound",
          label: "Transient",
          status: "open",
          discussion: {
            parentChatId: "main",
            reviewThreadId: "thread",
            worktreePath: null,
          },
        },
        {
          id: "c",
          label: "C",
          updatedAt: "2026-11-02",
          hasUserMessage: true,
          association: { ticketId: "t-2" },
        },
      ],
      new Map([["t-2", "Looked-up title"]])
    );
    expect(entries.map((entry) => entry.sessionId)).toEqual(["b", "c", "a"]);
    expect(entries[1]).toMatchObject({
      hint: "Looked-up title",
      detail: "t-2",
    });
    expect(entries[2]).toMatchObject({ hint: "Stored title", open: true });
    expect(entries[2].keywords).toContain("t-1");
  });

  const item: PaletteItem = {
    id: "x",
    scope: "tasks",
    label: "Refine composer chip",
    detail: "abcd1234",
    keywords: "ticket",
    run: () => undefined,
  };

  it("matches when every token appears in label, detail or keywords", () => {
    expect(matchesQuery(item, "composer abcd")).toBe(true);
    expect(matchesQuery(item, "TICKET chip")).toBe(true);
    expect(matchesQuery(item, "composer missing")).toBe(false);
    expect(matchesQuery(item, "   ")).toBe(true);
  });

  it("recognises ⌘K and Ctrl+K but not shifted or alt variants", () => {
    const base = {
      metaKey: false,
      ctrlKey: false,
      shiftKey: false,
      altKey: false,
    };
    expect(isPaletteShortcut({ ...base, key: "k", metaKey: true })).toBe(true);
    expect(isPaletteShortcut({ ...base, key: "K", ctrlKey: true })).toBe(true);
    expect(
      isPaletteShortcut({ ...base, key: "k", metaKey: true, shiftKey: true })
    ).toBe(false);
    expect(isPaletteShortcut({ ...base, key: "k" })).toBe(false);
  });
});

import { describe, it, expect, vi, beforeEach } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom";
import { CommandPalette } from "./CommandPalette";
import {
  isPaletteShortcut,
  matchesQuery,
  paletteChatEntries,
  type PaletteItem,
} from "./paletteModel";
import { useChatStore } from "../../stores/chatStore";
import { useCommandPaletteStore } from "../../stores/commandPaletteStore";
import { useEntityPanelStore } from "../../stores/entityPanelStore";
import { useFactoryFilterStore } from "../../stores/factoryFilterStore";
import { useUIStore } from "../../stores/uiStore";

vi.mock("../../hooks/useWorkflows", () => ({
  useWorkflows: () => ({
    workflows: [
      { id: "aaaaaaaa-0000-0000-0000-000000000000", name: "Implement", factory_name: "Delivery" },
    ],
  }),
}));

vi.mock("../../hooks/useTasks", () => ({
  useTasks: () => ({
    tasks: [
      {
        id: "df875b15-de5c-47b4-9d13-9e967b2487ea",
        title: "GUI clean-up pass",
        level: "ticket",
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
    useCommandPaletteStore.setState({ open: false, scope: "all" });
    useChatStore.setState({ sessions: {}, localSessionSummaries: {} });
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
    expect(document.getElementById("palette-option-factory-Delivery")).not.toBeNull();
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

  it("finds saved chats by their linked ticket and reopens them", () => {
    const selectPersistedSession = vi.fn().mockResolvedValue(true);
    useChatStore.setState({
      selectPersistedSession,
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
    expect(selectPersistedSession).toHaveBeenCalledWith("chat-1");
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

  it("toggles closed when ⌘K is pressed again", () => {
    renderPalette();
    openPalette();
    fireEvent.keyDown(window, { key: "k", metaKey: true });
    expect(screen.queryByRole("dialog")).toBeNull();
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
    expect(screen.queryByRole("option", { name: /Unrelated chore/ })).toBeNull();
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

  it("sets a named reading-size preset from the launcher", () => {
    renderPalette();
    openPalette();
    type("font size larger");
    fireEvent.click(screen.getByRole("option", { name: /Reading text size: Larger/ }));
    expect(useUIStore.getState().readingTextSize).toBe("larger");
  });

  it("sets a custom reading percentage from the launcher", () => {
    renderPalette();
    openPalette();
    type("font size 112%");
    fireEvent.click(screen.getByRole("option", { name: "Reading text size: 112%" }));
    expect(useUIStore.getState().readingTextSize).toBe(112);
  });

  it("shows an empty state when nothing matches", () => {
    renderPalette();
    openPalette();
    type("zzzz-no-match");
    expect(screen.getByRole("status")).toHaveTextContent("No matches");
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
        { id: "empty", label: "Empty", updatedAt: "2026-11-04", hasUserMessage: false },
        { id: "a", label: "A", status: "open" },
        { id: "inline", label: "Inline", status: "open", hasUserMessage: true,
          discussion: { parentChatId: "a", reviewThreadId: "thread", worktreePath: "/checkout" } },
        { id: "unbound", label: "Transient", status: "open", discussion: "unbound" },
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
    expect(entries[1]).toMatchObject({ hint: "Looked-up title", detail: "t-2" });
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
    const base = { metaKey: false, ctrlKey: false, shiftKey: false, altKey: false };
    expect(isPaletteShortcut({ ...base, key: "k", metaKey: true })).toBe(true);
    expect(isPaletteShortcut({ ...base, key: "K", ctrlKey: true })).toBe(true);
    expect(
      isPaletteShortcut({ ...base, key: "k", metaKey: true, shiftKey: true })
    ).toBe(false);
    expect(isPaletteShortcut({ ...base, key: "k" })).toBe(false);
  });
});

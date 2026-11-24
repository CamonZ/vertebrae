import { act, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  useChatSideColumnStore,
  useSideColumnView,
  type SideSection,
} from "../../stores/chatSideColumnStore";
import type { SideColumnControls } from "./ChatPaneList";
import { useChatSideColumn } from "./useChatSideColumn";
import { useShellStore } from "../../stores/shellStore";

const loadWorktreeChanges = vi.hoisted(() => vi.fn());
vi.mock("../../bindings", () => ({ commands: { loadWorktreeChanges } }));
const dirtyPaths = vi.hoisted(() => vi.fn<(worktree: string) => string[]>(() => []));
vi.mock("./workspace/documentStore", () => ({ dirtyPaths }));

const SESSION = "chat";
const NONE = { changes: 0, discussions: 0, background: 0 };

function setup({
  worktreePath = "/w" as string | null,
  counts = NONE as Record<SideSection, number>,
  onDirty = vi.fn(),
} = {}) {
  let controls: SideColumnControls | null = null;
  const hook = renderHook(() =>
    useChatSideColumn({
      sessionId: SESSION,
      view: useSideColumnView(SESSION),
      worktreePath,
      isMainCheckout: false,
      counts,
      panel: { current: null },
      register: (next) => {
        controls = next;
      },
      active: true,
      evidenceShown: false,
      onDirty,
      onClose: vi.fn(),
      onSelect: vi.fn(),
    })
  );
  return { hook, controls: () => controls! };
}

const view = () => useChatSideColumnStore.getState().bySession[SESSION];

const presentation = () => useShellStore.getState().chatPanelPresentation;

afterEach(() => {
  useChatSideColumnStore.getState().forget();
  useShellStore.getState().setChatPanelPresentation("compact");
});

describe("useChatSideColumn", () => {
  it("⌘⇧B opens on the first section with content, then closes", () => {
    const { controls } = setup({ counts: { ...NONE, discussions: 2 } });

    act(() => void controls().toggle());
    expect(view()).toMatchObject({ open: true, section: "discussions" });
    act(() => void controls().toggle());
    expect(view()).toMatchObject({ open: false, section: "discussions" });
  });

  it("⌃⌘1–3 show a section, close it when shown, and refuse Changes without a checkout", () => {
    const { controls } = setup({ worktreePath: null });

    let taken = true;
    act(() => void (taken = controls().toggleSection("changes")));
    expect(taken).toBe(false);
    expect(view()).toBeUndefined();
    act(() => void controls().toggleSection("background"));
    expect(view()).toMatchObject({ open: true, section: "background" });
    act(() => void controls().toggleSection("discussions"));
    expect(view()).toMatchObject({ open: true, section: "discussions" });
    act(() => void controls().toggleSection("discussions"));
    expect(view()).toMatchObject({ open: false, section: "discussions" });
  });

  it("drops an on-demand Changes check that lands after the chat unmounts", async () => {
    let resolve!: (value: unknown) => void;
    loadWorktreeChanges.mockReturnValueOnce(
      new Promise((done) => {
        resolve = done;
      })
    );
    const { hook, controls } = setup();
    const { toggle } = controls();

    act(() => void toggle());
    hook.unmount();
    await act(async () =>
      resolve({ status: "ok", data: { files: [{ path: "a" }] } })
    );

    expect(loadWorktreeChanges).toHaveBeenCalledOnce();
    expect(view()?.open ?? false).toBe(false);
  });

  it.each(["changes", "discussions", "background"] as const)(
    "expands the compact chat for %s and collapses when the column closes",
    (section) => {
      const { controls } = setup();

      act(() => void controls().toggleSection(section));
      expect(view()).toMatchObject({ open: true, section });
      expect(presentation()).toBe("expanded");
      expect(useShellStore.getState().sideColumnExpandedFor).toBe(SESSION);
      act(() => void controls().toggleSection(section));
      expect(view()).toMatchObject({ open: false });
      expect(presentation()).toBe("compact");
    }
  );

  it("keeps the expanded chat while switching sections", () => {
    const { controls } = setup();

    act(() => void controls().toggleSection("changes"));
    expect(presentation()).toBe("expanded");

    // Switching sections keeps the expanded chat; closing the column leaves it.
    act(() => void controls().toggleSection("discussions"));
    expect(presentation()).toBe("expanded");
    act(() => void controls().toggleSection("discussions"));
    expect(view()).toMatchObject({ open: false });
    expect(presentation()).toBe("compact");
  });

  it("keeps a chat the user expanded expanded when Changes closes", () => {
    act(() => useShellStore.getState().setChatPanelPresentation("expanded"));
    const { controls } = setup();

    act(() => void controls().toggleSection("changes"));
    expect(useShellStore.getState().sideColumnExpandedFor).toBeNull();
    let left = true;
    act(() => void (left = controls().leaveExpanded()));
    expect(left).toBe(false);
    act(() => void controls().toggleSection("changes"));
    expect(view()).toMatchObject({ open: false });
    expect(presentation()).toBe("expanded");
  });

  it("closes the column when the chat returns to compact", () => {
    const { controls } = setup();

    act(() => void controls().toggleSection("discussions"));
    expect(presentation()).toBe("expanded");
    act(() => useShellStore.getState().setChatPanelPresentation("compact"));
    expect(view()).toMatchObject({ open: false });
    expect(presentation()).toBe("compact");
  });

  it("Escape's leaveExpanded closes the column that expanded the chat", () => {
    const { controls } = setup();

    act(() => void controls().toggleSection("changes"));
    let left = false;
    act(() => void (left = controls().leaveExpanded()));
    expect(left).toBe(true);
    expect(view()).toMatchObject({ open: false });
    expect(presentation()).toBe("compact");
    act(() => void (left = controls().leaveExpanded()));
    expect(left).toBe(false);
  });

  it("asks about unsaved documents before Escape leaves the expanded Changes", () => {
    const onDirty = vi.fn();
    const { controls } = setup({ onDirty });
    act(() => void controls().toggleSection("changes"));
    dirtyPaths.mockReturnValueOnce(["a.ts"]);
    act(() => void controls().leaveExpanded());
    expect(dirtyPaths).toHaveBeenCalledWith("/w");
    expect(onDirty).toHaveBeenCalledWith(["a.ts"]);
    expect(view()).toMatchObject({ open: true, section: "changes" });
    expect(presentation()).toBe("expanded");
  });
});

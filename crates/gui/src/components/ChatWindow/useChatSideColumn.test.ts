import { act, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  useChatSideColumnStore,
  useSideColumnView,
  type SideSection,
} from "../../stores/chatSideColumnStore";
import type { SideColumnControls } from "./ChatPaneList";
import { useChatSideColumn } from "./useChatSideColumn";

const loadWorktreeChanges = vi.hoisted(() => vi.fn());
vi.mock("../../bindings", () => ({ commands: { loadWorktreeChanges } }));

const SESSION = "chat";
const NONE = { changes: 0, discussions: 0, background: 0 };

function setup({
  worktreePath = "/w" as string | null,
  counts = NONE as Record<SideSection, number>,
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
      onDirty: vi.fn(),
      onClose: vi.fn(),
      onSelect: vi.fn(),
    })
  );
  return { hook, controls: () => controls! };
}

const view = () => useChatSideColumnStore.getState().bySession[SESSION];

afterEach(() => useChatSideColumnStore.getState().forget());

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
});

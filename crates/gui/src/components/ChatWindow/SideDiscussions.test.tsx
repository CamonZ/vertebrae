import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { useCallback, useMemo, useRef, useState, type ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";
import type { ChatAttention } from "../../utils/chatAttention";
import { OWNS_ESCAPE_ATTRIBUTE } from "../../hooks/useGlassPanel";
import { ChatHeader } from "./ChatHeader";
import { ChatSideColumn } from "./ChatSideColumn";
import {
  DISCUSSION_LIST_KEYS,
  SIDE_COLUMN_SHORTCUTS,
  keyHintText,
  shortcutText,
} from "./chatShortcuts";
import { focusedPaletteScopes } from "../CommandPalette/paletteScopes";
import { SideDiscussions } from "./SideDiscussions";
import type { SideColumnControls } from "./ChatPaneList";
import { useChatSideColumn } from "./useChatSideColumn";
import { useSideColumnView } from "../../stores/chatSideColumnStore";
import {
  captureCodeSelection,
  type SelectionThread,
  type ThreadStatus,
} from "./selectionDiscussions";
import {
  SelectionDiscussionContext,
  type DiscussionValue,
} from "./selectionDiscussionState";
import { parsePatch } from "../thread/toolChange/diffLineMapper";
import type { DiscussedCode } from "./selectionDiscussions";

// Pierre renders in a worker; the test reads what it is handed.
vi.mock("./DiscussedCodeView", () => ({
  default: ({ code }: { code: DiscussedCode }) => (
    <pre data-testid="discussed-code">{JSON.stringify(code)}</pre>
  ),
}));

const file = parsePatch(
  "diff --git a/src/a.ts b/src/a.ts\n--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1,3 +1,3 @@\n-old\n+first\n+second\n+third\n"
)[0];
const home = { kind: "worktree", wholeBranch: true } as const;

function thread(
  id: string,
  line: number,
  status: ThreadStatus
): SelectionThread {
  const anchor = captureCodeSelection(
    file,
    { start: line, end: line, side: "additions" },
    home
  )!;
  return {
    id,
    anchor,
    status,
    git: {
      original: { ...anchor, code: `original ${id}` },
      capture: { originalBlobId: "blob", originalCommitId: "commit" },
    },
    outdatedNoted: false,
    sessionId: null,
    githubThreadId: null,
  };
}

const TWO_DETACHED_ONE_INLINE = [
  thread("inline", 1, { kind: "inline" }),
  thread("outdated", 2, { kind: "outdated" }),
  thread("gone", 3, { kind: "unavailable", lastKnown: "open" }),
];

/** A stateful stand-in for the chat's discussion provider. */
function Discussions({
  threads,
  anchorError = null,
  reopen: onReopen = () => {},
  children,
}: {
  threads: SelectionThread[];
  anchorError?: string | null;
  reopen?: DiscussionValue["reopen"];
  children: ReactNode;
}) {
  const [activeId, setActiveId] = useState<string | null>(null);
  const [focusRequest, setFocusRequest] = useState<string | null>(null);
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(new Set());
  const reopen = useCallback<DiscussionValue["reopen"]>(
    (id, options) => {
      onReopen(id, options);
      setActiveId(id);
      setFocusRequest(options?.focus ? id : null);
    },
    [onReopen]
  );
  const value = useMemo<DiscussionValue>(
    () => ({
      selection: null,
      threads,
      activeId,
      collapsed,
      focusRequest,
      anchorError,
      canAsk: true,
      select: vi.fn(),
      discuss: vi.fn(async () => true),
      attach: vi.fn(),
      reopen,
      send: vi.fn(),
      cancel: vi.fn(),
      reconcile: vi.fn(),
      reveal: null,
      discussGithub: vi.fn(async () => ({ opened: true as const })),
      attachThread: vi.fn(),
      canAttachGithub: false,
      attachGithub: vi.fn(),
      revealed: vi.fn(),
      draft: () => "",
      setDraft: vi.fn(),
      moveUnderGithub: vi.fn(async () => {}),
      toggleCollapsed: (id) =>
        setCollapsed((current) => {
          const next = new Set(current);
          if (!next.delete(id)) next.add(id);
          return next;
        }),
      focusTaken: () => setFocusRequest(null),
    }),
    [threads, activeId, collapsed, focusRequest, anchorError, reopen]
  );
  return (
    <SelectionDiscussionContext.Provider value={value}>
      {children}
    </SelectionDiscussionContext.Provider>
  );
}

function header() {
  return (
    <ChatHeader
      label="Chat"
      attention={{ state: "idle", reason: null, since: null } as ChatAttention}
      isClosing={false}
      canStopGeneration={false}
      onClearMessages={vi.fn()}
      onStopGeneration={vi.fn()}
      onToggleSection={vi.fn()}
      changesAvailable
    />
  );
}

const rows = () => screen.getAllByRole("button", { name: /^Discussion on / });

/** A chat's column as ChatWindow wires it: the hook, the switcher, content. */
function Column({
  register,
}: {
  register(controls: SideColumnControls | null): void;
}) {
  const panel = useRef<HTMLElement>(null);
  const side = useChatSideColumn({
    sessionId: "chat",
    view: useSideColumnView("chat"),
    worktreePath: null,
    isMainCheckout: false,
    counts: { changes: 0, discussions: 3, background: 0 },
    register,
    panel,
    active: true,
    evidenceShown: false,
    onDirty: vi.fn(),
    onClose: vi.fn(),
    onSelect: vi.fn(),
  });
  return (
    <aside ref={panel}>
      {side.shownSection && (
        <ChatSideColumn
          section={side.shownSection}
          counts={{ changes: null, background: null }}
          available={side.available}
          onSection={side.select}
        >
          {side.shownSection === "discussions" ? (
            <SideDiscussions />
          ) : (
            <section
              tabIndex={-1}
              aria-label="Background"
              data-chat-area="background"
            />
          )}
        </ChatSideColumn>
      )}
    </aside>
  );
}

describe("ChatSideColumn tabs", () => {
  const props = {
    counts: { changes: null, background: null },
    available: () => true,
  };

  it("shows the clicked section with the keyboard in it", () => {
    const onSection = vi.fn();
    render(
      <ChatSideColumn {...props} section="discussions" onSection={onSection}>
        <div />
      </ChatSideColumn>
    );

    fireEvent.click(screen.getByRole("tab", { name: /Background tasks/ }));
    expect(onSection).toHaveBeenCalledWith("background", true);
  });
});

describe("SideDiscussions", () => {
  it("shows a centred empty state with a `c` key hint and no key footer at zero discussions", () => {
    render(
      <Discussions threads={[]}>
        <SideDiscussions />
      </Discussions>
    );

    expect(screen.getByText("No discussions yet.")).toBeInTheDocument();
    const hint = document.querySelector(".side-empty-hint")!;
    expect(hint).toHaveTextContent(
      "Select code in Changes and press c to ask about it."
    );
    expect(hint.querySelector("kbd.chat-comment-kbd")).toHaveTextContent("c");
    expect(screen.queryByLabelText("Discussions keys")).toBeNull();
  });

  it("lists its keys once there are discussions", () => {
    render(
      <Discussions threads={TWO_DETACHED_ONE_INLINE}>
        <SideDiscussions />
      </Discussions>
    );

    expect(screen.getByLabelText("Discussions keys")).toBeInTheDocument();
    expect(screen.queryByText("No discussions yet.")).toBeNull();
  });

  it("puts the keyboard in a section chosen by key, click or ↓ from the tabs", async () => {
    let controls: SideColumnControls | null = null;
    render(
      <Discussions threads={TWO_DETACHED_ONE_INLINE}>
        <Column register={(next) => (controls = next)} />
      </Discussions>
    );

    // ⌃⌘2: the first discussion has the keys, so ↓ moves at once.
    act(() => void controls!.toggleSection("discussions"));
    await waitFor(() => expect(rows()[0]).toHaveFocus());
    fireEvent.keyDown(rows()[0], { key: "ArrowDown" });
    expect(rows()[1]).toHaveFocus();

    // ←/→ on the tabs stay on the tabs; ↓ enters the shown section.
    const tab = screen.getByRole("tab", { name: /Discussions/ });
    act(() => tab.focus());
    fireEvent.keyDown(tab, { key: "ArrowRight" });
    const background = screen.getByRole("tab", { name: /Background/ });
    expect(background).toHaveAttribute("aria-selected", "true");
    fireEvent.keyDown(screen.getByRole("tablist"), { key: "ArrowDown" });
    expect(screen.getByRole("region", { name: "Background" })).toHaveFocus();

    // A click on a tab hands the keys to its content.
    fireEvent.click(screen.getByRole("tab", { name: /Discussions/ }));
    await waitFor(() => expect(rows()[0]).toHaveFocus());
  });

  it("lists detached threads first with their original code, then inline ones (criterion 1)", () => {
    render(
      <Discussions threads={TWO_DETACHED_ONE_INLINE}>
        {header()}
        <ChatSideColumn
          section="discussions"
          counts={{ changes: 4, background: null }}
          available={() => true}
          onSection={vi.fn()}
        >
          <SideDiscussions />
        </ChatSideColumn>
      </Discussions>
    );

    expect(
      screen.getByRole("button", { name: "Discussions, 3" })
    ).toBeVisible();
    expect(screen.getByRole("tab", { selected: true })).toHaveTextContent(
      "Discussions3"
    );
    const detached = screen.getByRole("group", { name: "Detached, 2" });
    const inline = screen.getByRole("group", { name: "In Changes, 1" });
    expect(
      detached.compareDocumentPosition(inline) &
        Node.DOCUMENT_POSITION_FOLLOWING
    ).toBeTruthy();
    expect(
      within(detached)
        .getAllByLabelText("Original selected code")
        .map((code) => code.textContent)
    ).toEqual(["original outdated", "original gone"]);
    expect(within(detached).getByText("Outdated context")).toBeVisible();
    expect(within(detached).getByText("Anchor unavailable")).toBeVisible();
    expect(
      within(inline).queryByLabelText("Original selected code")
    ).toBeNull();
    // Each thread exactly once.
    expect(rows()).toHaveLength(3);
  });

  it("keeps the Discussions toggle visible with discussions while another section shows (constraint 3)", () => {
    render(
      <Discussions threads={TWO_DETACHED_ONE_INLINE}>
        <ChatHeader
          label="Chat"
          attention={
            { state: "idle", reason: null, since: null } as ChatAttention
          }
          isClosing={false}
          canStopGeneration={false}
          onClearMessages={vi.fn()}
          onStopGeneration={vi.fn()}
          onToggleSection={vi.fn()}
          sideSection="changes"
          changesAvailable
        />
      </Discussions>
    );

    expect(screen.getByTestId("local-chat-view-discussions")).toBeVisible();
  });

  it("puts the Discussions toggle in the overflow menu without discussions", () => {
    render(<Discussions threads={[]}>{header()}</Discussions>);

    expect(screen.queryByTestId("local-chat-view-discussions")).toBeNull();
  });

  it("shows the anchor error as an alert and gives the header toggle an alert state (criterion 4)", () => {
    render(
      <Discussions
        threads={[]}
        anchorError="Could not check anchors: git failed"
      >
        {header()}
        <SideDiscussions />
      </Discussions>
    );

    const section = screen.getByRole("region", { name: "Discussions" });
    expect(within(section).getByRole("alert")).toHaveTextContent(
      "Could not check anchors: git failed"
    );
    expect(section.firstElementChild).toBe(within(section).getByRole("alert"));
    const toggle = screen.getByTestId("local-chat-view-discussions");
    expect(toggle).toHaveAttribute("data-alert");
    expect(toggle).toHaveAccessibleName("Discussions, anchor error");
    expect(toggle.title).toContain(shortcutText(SIDE_COLUMN_SHORTCUTS.toggle));
  });

  it("moves through one list with ↑/↓ and enters it from the section", () => {
    render(
      <Discussions threads={TWO_DETACHED_ONE_INLINE}>
        <SideDiscussions />
      </Discussions>
    );
    const section = screen.getByRole("region", { name: "Discussions" });
    const [outdated, gone, inline] = rows();

    act(() => section.focus());
    fireEvent.keyDown(section, { key: "ArrowDown" });
    expect(outdated).toHaveFocus();
    fireEvent.keyDown(outdated, { key: "ArrowDown" });
    expect(gone).toHaveFocus();
    fireEvent.keyDown(gone, { key: "ArrowDown" });
    expect(inline).toHaveFocus();
    fireEvent.keyDown(inline, { key: "ArrowDown" });
    expect(inline).toHaveFocus();
    fireEvent.keyDown(inline, { key: "ArrowUp" });
    expect(gone).toHaveFocus();
    act(() => section.focus());
    fireEvent.keyDown(section, { key: "ArrowUp" });
    expect(inline).toHaveFocus();
  });

  it("opens a thread in place with focus in its composer; Esc closes it back to its row (criterion 5)", async () => {
    const reopen = vi.fn();
    render(
      <Discussions threads={TWO_DETACHED_ONE_INLINE} reopen={reopen}>
        <SideDiscussions />
      </Discussions>
    );
    const [outdated] = rows();
    act(() => outdated.focus());

    fireEvent.keyDown(outdated, { key: "Enter" });

    expect(reopen).toHaveBeenLastCalledWith("outdated", {
      focus: true,
      inPlace: true,
    });
    const card = await screen.findByTestId("selection-mini-thread");
    const composer = within(card).getByRole("textbox");
    await waitFor(() => expect(composer).toHaveFocus());
    // The chat workspace's glass panel leaves this Esc to the thread.
    expect(card).toHaveAttribute(OWNS_ESCAPE_ATTRIBUTE);

    fireEvent.keyDown(composer, { key: "Escape" });

    expect(screen.queryByTestId("selection-mini-thread")).toBeNull();
    await waitFor(() => expect(rows()[0]).toHaveFocus());
  });

  it("shows an opened anchored thread's diff chunk, with its lines selected", async () => {
    render(
      <Discussions threads={TWO_DETACHED_ONE_INLINE}>
        <SideDiscussions />
      </Discussions>
    );
    // Listed rows stay one line each.
    expect(screen.queryByLabelText("Code under discussion")).toBeNull();

    fireEvent.click(rows()[2]);

    const card = await screen.findByTestId("selection-mini-thread");
    const shown = await within(card).findByTestId("discussed-code");
    const code = JSON.parse(shown.textContent ?? "") as DiscussedCode;
    if (code.kind !== "diff") throw new Error("expected a diff chunk");
    expect(code.selection).toEqual({ start: 1, end: 1, side: "additions" });
    // The selection (new line 1) with the hunk's rows around it.
    expect(
      parsePatch(code.patch)[0].hunks.map((hunk) =>
        hunk.rows.map((row) => [row.kind, row.text])
      )
    ).toEqual([
      [
        ["del", "old"],
        ["add", "first"],
        ["add", "second"],
        ["add", "third"],
        // The fixture patch's trailing newline is a blank context row.
        ["context", ""],
      ],
    ]);
    expect(screen.getAllByLabelText("Code under discussion")).toHaveLength(1);
  });

  it("shows no diff chunk for an opened detached thread", async () => {
    render(
      <Discussions threads={TWO_DETACHED_ONE_INLINE}>
        <SideDiscussions />
      </Discussions>
    );
    fireEvent.click(rows()[0]);

    const card = await screen.findByTestId("selection-mini-thread");
    expect(within(card).queryByLabelText("Code under discussion")).toBeNull();
    expect(within(card).getByLabelText("Original selected code")).toBeTruthy();
  });

  it("shows an inline thread's code in Changes with o, only for inline threads", () => {
    const reopen = vi.fn();
    render(
      <Discussions threads={TWO_DETACHED_ONE_INLINE} reopen={reopen}>
        <SideDiscussions />
      </Discussions>
    );
    const [outdated, , inline] = rows();

    fireEvent.keyDown(outdated, { key: "o" });
    expect(reopen).not.toHaveBeenCalled();
    fireEvent.keyDown(inline, { key: "o" });
    expect(reopen).toHaveBeenCalledExactlyOnceWith("inline", { focus: true });
  });

  it("groups transcript and full-file threads where they are drawn; o is Changes-only", () => {
    const reopen = vi.fn();
    const inChanges = thread("inline", 1, { kind: "inline" });
    const onToolCall: SelectionThread = {
      ...thread("tool", 2, { kind: "inline" }),
      anchor: {
        ...inChanges.anchor,
        home: { kind: "tool_call", toolUseId: "tu-1" },
      },
    };
    const fullFile: SelectionThread = {
      ...thread("file", 3, { kind: "inline" }),
      anchor: { ...inChanges.anchor, fullFile: { checkout: "/w", turn: null } },
    };
    render(
      <Discussions threads={[fullFile, onToolCall, inChanges]} reopen={reopen}>
        <SideDiscussions />
      </Discussions>
    );

    const groups = screen
      .getAllByRole("group")
      .map((g) => g.getAttribute("aria-label"));
    expect(groups).toEqual([
      "In Changes, 1",
      "In the transcript, 1",
      "In open files, 1",
    ]);
    const [changesRow, toolRow, fileRow] = rows();
    for (const row of [toolRow, fileRow]) {
      expect(row).toHaveAttribute("aria-keyshortcuts", "Enter Meta+C");
      expect(row.title).not.toContain("Changes");
      fireEvent.keyDown(row, { key: "o" });
    }
    expect(reopen).not.toHaveBeenCalled();
    expect(changesRow.title).toContain("show in Changes (o)");
    fireEvent.keyDown(changesRow, { key: "o" });
    expect(reopen).toHaveBeenCalledExactlyOnceWith("inline", { focus: true });
  });

  it("offers the focused row's keys in the palette's Discussions scope", () => {
    const reopen = vi.fn();
    const writeText = vi.fn(async () => {});
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText },
    });
    render(
      <Discussions threads={TWO_DETACHED_ONE_INLINE} reopen={reopen}>
        <SideDiscussions />
      </Discussions>
    );
    const [outdated, , inline] = rows();

    act(() => inline.focus());
    const opened = focusedPaletteScopes();
    expect(opened.initial).toBe("discussions");
    let contexts = opened.contexts;
    const items = contexts[0].items;
    expect(items.map((item) => [item.label, item.access])).toEqual([
      ["Next discussion", { key: keyHintText(DISCUSSION_LIST_KEYS.move) }],
      ["Previous discussion", { key: keyHintText(DISCUSSION_LIST_KEYS.move) }],
      [DISCUSSION_LIST_KEYS.reply.label, { key: "↵" }],
      [DISCUSSION_LIST_KEYS.showCode.label, { key: "o" }],
      [
        DISCUSSION_LIST_KEYS.copy.label,
        { key: keyHintText(DISCUSSION_LIST_KEYS.copy) },
      ],
      ["Fold earlier turns", { key: keyHintText(DISCUSSION_LIST_KEYS.fold) }],
    ]);
    act(() =>
      items.find((item) => item.label === "Previous discussion")!.run()
    );
    expect(rows()[1]).toHaveFocus();
    items
      .find((item) => item.label === DISCUSSION_LIST_KEYS.showCode.label)!
      .run();
    expect(reopen).toHaveBeenCalledExactlyOnceWith("inline", { focus: true });

    // Not in Changes: no "show code"; the copy acts on this row.
    act(() => outdated.focus());
    ({ contexts } = focusedPaletteScopes());
    const labels = contexts[0].items.map((item) => item.label);
    expect(labels).not.toContain(DISCUSSION_LIST_KEYS.showCode.label);
    contexts[0].items
      .find((item) => item.label === DISCUSSION_LIST_KEYS.copy.label)!
      .run();
    expect(writeText).toHaveBeenCalledExactlyOnceWith("original outdated");
  });

  it("copies the original code with ⌘C and folds with ←/→", () => {
    const writeText = vi.fn(async () => {});
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText },
    });
    render(
      <Discussions threads={TWO_DETACHED_ONE_INLINE}>
        <SideDiscussions />
      </Discussions>
    );
    const [outdated] = rows();

    fireEvent.keyDown(outdated, { key: "c", code: "KeyC", metaKey: true });
    expect(writeText).toHaveBeenCalledExactlyOnceWith("original outdated");

    const left = fireEvent.keyDown(outdated, { key: "ArrowLeft" });
    expect(left).toBe(false); // folded: the key was taken
    const again = fireEvent.keyDown(outdated, { key: "ArrowLeft" });
    expect(again).toBe(true); // already folded: nothing to do
    expect(fireEvent.keyDown(outdated, { key: "ArrowRight" })).toBe(false);
  });
});

import { loadMainChatWorktree } from "../../utils/chatAssociation/defaultWorktree";
import { getProjectScopeGeneration } from "../../stores/projectScopedStores";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { commands } from "../../bindings";
import { useTasks } from "../../hooks/useTasks";
import { useWorkflows } from "../../hooks/useWorkflows";
import { useFactoryFilterStore } from "../../stores/factoryFilterStore";
import { NO_FACTORY_SCOPE, factoryNames } from "../../utils/workflowFactory";
import { useChatStore } from "../../stores/chatStore";
import { useCommandPaletteStore } from "../../stores/commandPaletteStore";
import { useEntityPanelStore } from "../../stores/entityPanelStore";
import { isReadingPercent, READING_SIZE_PRESETS } from "../../utils/readingAppearance";
import { ACCENTS, TYPE_PAIRINGS, useUIStore } from "../../stores/uiStore";
import {
  isPaletteShortcut,
  isTypingTarget,
  labelMatchesQuery,
  matchesQuery,
  paletteChatEntries,
  type PaletteItem,
  type PaletteScope,
} from "./paletteModel";

const SCOPES: { id: PaletteScope; label: string }[] = [
  { id: "all", label: "All" },
  { id: "navigate", label: "Go to" },
  { id: "tasks", label: "Tasks" },
  { id: "chats", label: "Chats" },
  { id: "workflows", label: "Workflows" },
  { id: "actions", label: "Actions" },
];

const SCOPE_HEADINGS: Record<Exclude<PaletteScope, "all">, string> = {
  navigate: "Go to",
  tasks: "Tasks",
  chats: "Chats",
  workflows: "Workflows",
  actions: "Actions",
};

/** Stable sort: label matches first, then matches only in ID, tags or text. */
function rankByLabel(items: PaletteItem[], query: string): PaletteItem[] {
  if (!query.trim()) return items;
  const strong: PaletteItem[] = [];
  const weak: PaletteItem[] = [];
  for (const item of items) {
    (labelMatchesQuery(item, query) ? strong : weak).push(item);
  }
  return [...strong, ...weak];
}

/** Per-scope cap so a long task list never buries navigation and actions. */
const MAX_PER_SCOPE = 8;

async function startFreshProjectChat() {
  const generation = getProjectScopeGeneration();
  const projectPath = await currentProjectPath();
  const mainWorktree = await loadMainChatWorktree(projectPath);
  if (generation === getProjectScopeGeneration() && useChatStore.getState().panelOpen) {
    useChatStore
      .getState()
      .startFreshSession("New Chat", projectPath, mainWorktree);
  }
}

async function currentProjectPath(): Promise<string | null> {
  try {
    const result = await commands.getCurrentProjectPath();
    return result.status === "ok" && result.data ? result.data : null;
  } catch {
    return null;
  }
}

/** "/" opens the palette on the list a page used to search on its own. */
function defaultScopeForPath(pathname: string): PaletteScope {
  if (pathname.startsWith("/tasks")) return "tasks";
  if (pathname.startsWith("/design")) return "workflows";
  return "all";
}

/**
 * ⌘K command palette: one keyboard entry point to navigate, find tasks,
 * reopen chats (including saved history, matched by their linked ticket),
 * and run app actions. "/" opens it too, scoped to tasks on task pages.
 * Scope tabs narrow the list; the footer shows the key hints.
 */
export function CommandPalette() {
  const open = useCommandPaletteStore((state) => state.open);
  const scope = useCommandPaletteStore((state) => state.scope);
  const togglePalette = useCommandPaletteStore((state) => state.togglePalette);
  const openPalette = useCommandPaletteStore((state) => state.openPalette);
  const closePalette = useCommandPaletteStore((state) => state.closePalette);
  const { pathname } = useLocation();

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (isPaletteShortcut(event)) {
        event.preventDefault();
        togglePalette();
        return;
      }
      if (
        event.key === "/" &&
        !event.metaKey &&
        !event.ctrlKey &&
        !event.altKey &&
        !useCommandPaletteStore.getState().open &&
        !isTypingTarget(event.target)
      ) {
        event.preventDefault();
        openPalette(defaultScopeForPath(pathname));
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [openPalette, pathname, togglePalette]);

  if (!open) return null;
  return <PaletteDialog initialScope={scope} onClose={closePalette} />;
}

function PaletteDialog({
  initialScope,
  onClose,
}: {
  initialScope: PaletteScope;
  onClose: () => void;
}) {
  const navigate = useNavigate();
  const [query, setQuery] = useState("");
  const [scope, setScope] = useState<PaletteScope>(initialScope);
  const [activeIndex, setActiveIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const restoreFocusRef = useRef<Element | null>(document.activeElement);

  const { tasks } = useTasks();
  const { workflows } = useWorkflows();
  const setFactoryName = useFactoryFilterStore((state) => state.setFactoryName);
  const openWorkflow = useEntityPanelStore((state) => state.openWorkflow);
  const sessions = useChatStore((state) => state.sessions);
  const localSessionSummaries = useChatStore(
    (state) => state.localSessionSummaries
  );
  const openTask = useEntityPanelStore((state) => state.openTask);
  const setTheme = useUIStore((state) => state.setTheme);
  const setTypePairing = useUIStore((state) => state.setTypePairing);
  const setReadingTextSize = useUIStore((state) => state.setReadingTextSize);
  const setAccent = useUIStore((state) => state.setAccent);

  const close = useCallback(() => {
    onClose();
    const previous = restoreFocusRef.current;
    if (previous instanceof HTMLElement) previous.focus();
  }, [onClose]);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  const items = useMemo<PaletteItem[]>(() => {
    const nav: PaletteItem[] = [
      { id: "nav-tasks", scope: "navigate", label: "Tasks", run: () => navigate("/tasks") },
      { id: "nav-atlas", scope: "navigate", label: "Workflow atlas", keywords: "design workflows", run: () => navigate("/design") },
      { id: "nav-artifacts", scope: "navigate", label: "Artifacts", run: () => navigate("/artifacts") },
      { id: "nav-daemons", scope: "navigate", label: "Daemons", run: () => navigate("/daemons") },
      { id: "nav-settings", scope: "navigate", label: "Settings", keywords: "preferences providers", run: () => navigate("/settings") },
    ];
    const actions: PaletteItem[] = [
      {
        id: "action-new-chat",
        scope: "actions",
        label: "New chat",
        keywords: "start fresh local chat",
        run: async () => {
          const chat = useChatStore.getState();
          chat.setPanelOpen(true);
          await startFreshProjectChat();
        },
      },
      {
        id: "action-toggle-chat",
        scope: "actions",
        label: "Toggle chat panel",
        detail: "⌥ ⌥",
        run: async () => {
          const chat = useChatStore.getState();
          if (chat.panelOpen) {
            chat.togglePanel();
            return;
          }
          // Like the launcher pill: opening with no active chat starts one,
          // so the panel never opens empty.
          chat.setPanelOpen(true);
          const active = chat.activeSessionId
            ? chat.sessions[chat.activeSessionId]
            : undefined;
          if (!active) {
            await startFreshProjectChat();
          }
        },
      },
      { id: "action-theme-dark", scope: "actions", label: "Theme: Dark", keywords: "appearance", run: () => setTheme("dark") },
      { id: "action-theme-light", scope: "actions", label: "Theme: Light", keywords: "appearance", run: () => setTheme("light") },
      { id: "action-theme-system", scope: "actions", label: "Theme: System", keywords: "appearance", run: () => setTheme("system") },
      ...READING_SIZE_PRESETS.map(
        ({ value, label, percent }): PaletteItem => ({
          id: `action-reading-size-${value}`,
          scope: "actions",
          label: `Reading text size: ${label}`,
          detail: `${percent}%`,
          keywords: "font size appearance scale",
          run: () => setReadingTextSize(value),
        })
      ),
      ...TYPE_PAIRINGS.map(
        (pairing): PaletteItem => ({
          id: `action-type-${pairing.value}`,
          scope: "actions",
          label: `Typeface: ${pairing.label}`,
          hint: pairing.description,
          keywords: "font appearance typography",
          run: () => setTypePairing(pairing.value),
        })
      ),
      ...ACCENTS.map(
        (accent): PaletteItem => ({
          id: `action-accent-${accent.value}`,
          scope: "actions",
          label: `Accent: ${accent.label}`,
          hint: accent.description,
          keywords: "colour color appearance theme",
          run: () => setAccent(accent.value),
        })
      ),
    ];
    const taskItems: PaletteItem[] = (tasks ?? []).map((task) => ({
      id: `task-${task.id}`,
      scope: "tasks",
      label: task.title,
      detail: task.id.slice(0, 8),
      keywords: [
        task.id,
        task.level ?? "",
        ...(task.tags ?? []),
        task.description ?? "",
      ].join(" "),
      run: () => openTask(task.id),
    }));
    const taskTitles = new Map(
      (tasks ?? []).map((task) => [task.id, task.title] as const)
    );
    const chatItems: PaletteItem[] = paletteChatEntries(
      [
        ...Object.values(localSessionSummaries),
        ...Object.values(sessions),
      ],
      taskTitles
    ).map((entry) => ({
      id: `chat-${entry.sessionId}`,
      scope: "chats",
      label: entry.label,
      hint: entry.hint,
      detail: entry.detail,
      keywords: entry.keywords,
      run: () => {
        const chat = useChatStore.getState();
        chat.setPanelOpen(true);
        if (entry.open) {
          chat.focusSession(entry.sessionId);
        } else {
          void chat.selectPersistedSession(entry.sessionId);
        }
      },
    }));
    const workflowList = workflows ?? [];
    const factoryItems: PaletteItem[] = factoryNames(workflowList).map(
      (name) => ({
        id: `factory-${name}`,
        scope: "workflows",
        label: name,
        hint: "Factory",
        keywords: "factory",
        run: () => {
          setFactoryName(name);
          navigate("/design");
        },
      })
    );
    const workflowItems: PaletteItem[] = workflowList
      .filter((workflow) => workflow.id)
      .map((workflow) => ({
        id: `workflow-${workflow.id}`,
        scope: "workflows",
        label: workflow.name,
        hint: workflow.factory_name ?? undefined,
        detail: workflow.id!.slice(0, 8),
        keywords: `workflow ${workflow.id}`,
        run: () => {
          // Show the workflow inside its factory, then open its inspector.
          setFactoryName(workflow.factory_name ?? NO_FACTORY_SCOPE);
          navigate("/design");
          openWorkflow(workflow.id!);
        },
      }));
    return [
      ...nav,
      ...taskItems,
      ...chatItems,
      ...factoryItems,
      ...workflowItems,
      ...actions,
    ];
  }, [
    localSessionSummaries,
    navigate,
    openTask,
    openWorkflow,
    sessions,
    setFactoryName,
    setTheme,
    setTypePairing,
    setReadingTextSize,
    setAccent,
    tasks,
    workflows,
  ]);

  const groups = useMemo(() => {
    // Short, fixed lists first so pages and actions are never buried under
    // the (much longer) task list.
    const order: Exclude<PaletteScope, "all">[] = [
      "navigate",
      "actions",
      "chats",
      "workflows",
      "tasks",
    ];
    const customPercent = Number(
      /^(?:reading(?: text)? size|font size)\s+(\d{2,3})%?$/i.exec(query.trim())?.[1]
    );
    const customSize: PaletteItem[] = isReadingPercent(customPercent)
      ? [{
          id: "action-reading-size-custom",
          scope: "actions",
          label: `Reading text size: ${customPercent}%`,
          run: () => setReadingTextSize(customPercent),
        }]
      : [];
    return order
      .filter((id) => scope === "all" || scope === id)
      .map((id) => ({
        id,
        items: [
          ...(id === "actions" ? customSize : []),
          ...rankByLabel(
            items.filter((item) => item.scope === id && matchesQuery(item, query)),
            query
          ),
        ].slice(0, scope === "all" ? MAX_PER_SCOPE : undefined),
      }))
      .filter((group) => group.items.length > 0);
  }, [items, query, scope, setReadingTextSize]);

  const flat = useMemo(() => groups.flatMap((group) => group.items), [groups]);

  useEffect(() => {
    setActiveIndex(0);
  }, [query, scope]);

  useEffect(() => {
    listRef.current
      ?.querySelector<HTMLElement>(`[data-index="${activeIndex}"]`)
      ?.scrollIntoView?.({ block: "nearest" });
  }, [activeIndex]);

  const runItem = useCallback(
    (item: PaletteItem | undefined) => {
      if (!item) return;
      onClose();
      void item.run();
    },
    [onClose]
  );

  const onKeyDown = (event: React.KeyboardEvent) => {
    if (event.key === "Escape") {
      event.preventDefault();
      close();
    } else if (event.key === "ArrowDown") {
      event.preventDefault();
      setActiveIndex((index) => (flat.length ? (index + 1) % flat.length : 0));
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      setActiveIndex((index) =>
        flat.length ? (index - 1 + flat.length) % flat.length : 0
      );
    } else if (event.key === "Enter") {
      event.preventDefault();
      runItem(flat[activeIndex]);
    } else if (event.key === "Tab") {
      event.preventDefault();
      const current = SCOPES.findIndex((entry) => entry.id === scope);
      const delta = event.shiftKey ? -1 : 1;
      setScope(SCOPES[(current + delta + SCOPES.length) % SCOPES.length].id);
    }
  };

  const activeId = flat[activeIndex]
    ? `palette-option-${flat[activeIndex].id}`
    : undefined;
  let index = -1;

  return (
    <div
      className="cmdk-backdrop"
      data-testid="command-palette"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) close();
      }}
    >
      <div
        className="cmdk"
        role="dialog"
        aria-modal="true"
        aria-label="Command palette"
        onKeyDown={onKeyDown}
      >
        <div className="cmdk-search">
          <svg aria-hidden="true" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth={1.8} viewBox="0 0 24 24">
            <circle cx="11" cy="11" r="6.5" />
            <path d="m16 16 4 4" />
          </svg>
          <input
            ref={inputRef}
            className="cmdk-input"
            placeholder="Search tasks, chats, workflows, pages and actions…"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            role="combobox"
            aria-expanded="true"
            aria-controls="command-palette-list"
            aria-activedescendant={activeId}
            aria-label="Search commands"
            autoComplete="off"
            autoCorrect="off"
            autoCapitalize="off"
            spellCheck={false}
            data-testid="command-palette-input"
          />
          <kbd className="cmdk-kbd">esc</kbd>
        </div>
        <div className="cmdk-scopes" role="tablist" aria-label="Palette scope">
          {SCOPES.map((entry) => (
            <button
              key={entry.id}
              type="button"
              role="tab"
              aria-selected={scope === entry.id}
              className="cmdk-scope"
              tabIndex={-1}
              onClick={() => {
                setScope(entry.id);
                inputRef.current?.focus();
              }}
            >
              {entry.label}
            </button>
          ))}
        </div>
        <div
          ref={listRef}
          id="command-palette-list"
          className="cmdk-list"
          role="listbox"
          aria-label="Results"
        >
          {flat.length === 0 ? (
            <div className="cmdk-empty" role="status">
              No matches
            </div>
          ) : (
            groups.map((group) => (
              <div key={group.id} role="group" aria-label={SCOPE_HEADINGS[group.id]}>
                <div className="cmdk-heading" aria-hidden="true">
                  {SCOPE_HEADINGS[group.id]}
                </div>
                {group.items.map((item) => {
                  index += 1;
                  const itemIndex = index;
                  return (
                    <div
                      key={item.id}
                      id={`palette-option-${item.id}`}
                      role="option"
                      aria-selected={itemIndex === activeIndex}
                      data-index={itemIndex}
                      className="cmdk-item"
                      onMouseMove={() => setActiveIndex(itemIndex)}
                      onClick={() => runItem(item)}
                    >
                      <span className="cmdk-label">{item.label}</span>
                      {item.hint && (
                        <span className="cmdk-hint">{item.hint}</span>
                      )}
                      {item.detail && (
                        <span className="cmdk-detail">{item.detail}</span>
                      )}
                    </div>
                  );
                })}
              </div>
            ))
          )}
        </div>
        <div className="cmdk-foot" aria-hidden="true">
          <span><kbd className="cmdk-kbd">↑</kbd><kbd className="cmdk-kbd">↓</kbd> navigate</span>
          <span><kbd className="cmdk-kbd">↵</kbd> open</span>
          <span><kbd className="cmdk-kbd">tab</kbd> scope</span>
          <span><kbd className="cmdk-kbd">esc</kbd> close</span>
        </div>
      </div>
    </div>
  );
}

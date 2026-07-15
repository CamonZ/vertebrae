import { useCallback, useEffect, useRef, useState } from "react";
import { NavLink, useNavigate } from "react-router-dom";
import { commands } from "../bindings";
import {
  useCurrentProject,
  projectAvatarBucket,
} from "../hooks/useCurrentProject";
import { resetProjectScopedStores } from "../stores";
import { open } from "@tauri-apps/plugin-dialog";
import { Tooltip } from "./atoms/Tooltip";
import { Icon } from "./atoms/Icon";
import { ThemeToggle } from "./ThemeToggle";
import {
  useWebSocketStatus,
  type WebSocketStatus,
} from "../hooks/useWebSocketStatus";

interface NavItemProps {
  to: string;
  id: string;
  label: string;
  icon: React.ReactNode;
  /** Render a small dot in the corner — used for unread/needs-attention. */
  withDot?: boolean;
}

function NavItem({ to, id, label, icon, withDot }: NavItemProps) {
  return (
    <li>
      <NavLink
        to={to}
        data-testid={`sidebar-nav-${id}`}
        title={label}
        aria-label={label}
        className={({ isActive }) =>
          [
            // 28px box matches the design rail's `.app-rail .item` (and our
            // 28px project avatar) — keeps the icon pitch tight per the v2 shell.
            "group relative flex h-7 w-7 items-center justify-center rounded-[var(--radius-md)]",
            "transition-[background-color,color] duration-[var(--t-fast)] ease-[var(--ease-default)]",
            "focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-accent)]",
            isActive
              ? "bg-[var(--color-accent-wash)] text-[var(--color-accent)]"
              : "text-[var(--color-fg-mute)] hover:bg-[var(--color-bg-1)] hover:text-[var(--color-fg)]",
          ].join(" ")
        }
      >
        {({ isActive }) => (
          <>
            {isActive && (
              <span
                aria-hidden
                // Active marker — matches the design rail's `.item.active::before`:
                // 2px×20px accent bar, offset -8px, with the soft ember glow that
                // diffuses its edge (without it the raw accent reads harder and thinner).
                className="absolute left-[-8px] top-1/2 h-5 w-0.5 -translate-y-1/2 rounded-r bg-[var(--color-accent)] shadow-[0_0_6px_var(--color-accent-glow)]"
              />
            )}
            <span className="relative shrink-0">
              {icon}
              {withDot && (
                <span
                  aria-hidden
                  className="absolute -right-1 -top-1 h-1.5 w-1.5 rounded-full bg-[var(--color-err)] shadow-[0_0_4px_var(--color-err)]"
                />
              )}
            </span>
          </>
        )}
      </NavLink>
    </li>
  );
}

/**
 * Hashed-color project avatar with name monogram. Eight palette buckets
 * derived from the project name — no user setup required.
 */
function ProjectAvatar({
  name,
  path,
  onClick,
  buttonRef,
  disabled = false,
}: {
  name: string;
  path: string;
  onClick: () => void;
  buttonRef?: React.Ref<HTMLButtonElement>;
  disabled?: boolean;
}) {
  const bucket = projectAvatarBucket(name);
  const palette = [
    "bg-[oklch(0.62_0.15_55)]", // accent deep
    "bg-[oklch(0.55_0.15_145)]", // green
    "bg-[oklch(0.55_0.15_75)]", // amber
    "bg-[oklch(0.55_0.13_220)]", // blue
    "bg-[oklch(0.50_0.18_25)]", // red
    "bg-[oklch(0.48_0.18_285)]", // violet
    "bg-[oklch(0.50_0.15_145)]", // green deep
    "bg-[oklch(0.42_0.04_250)]", // slate
  ];
  return (
    <Tooltip label={path} placement="right" delay={400}>
      <button
        ref={buttonRef}
        type="button"
        onClick={onClick}
        disabled={disabled}
        aria-label={`Switch project · ${name}`}
        data-testid="sidebar-project-avatar"
        className={[
          "flex h-7 w-7 items-center justify-center rounded-[var(--radius-md)]",
          // Project monogram is part of the Hearth wordmark family — serif
          // italic (Newsreader), not the mono UI numerals. `leading-none`
          // collapses the line box so the glyph centers vertically (matching
          // the design's `.app-rail .logo`); the 0.5px right→left translate is
          // an optical nudge to counter the italic slant pushing the glyph
          // visually right.
          "font-serif text-base italic leading-none text-white",
          "[transform:translateX(-0.5px)]",
          "ring-0 transition-shadow duration-[var(--t-fast)] hover:ring-2 hover:ring-[var(--color-accent-wash)]",
          "disabled:cursor-wait disabled:opacity-60",
          palette[bucket],
        ].join(" ")}
      >
        {name.charAt(0).toUpperCase()}
      </button>
    </Tooltip>
  );
}

interface ProjectListEntry {
  slug: string;
  path: string;
}

/**
 * Popover anchored to the project avatar. Lists known projects — clicking an
 * entry switches the active project — and offers a "+" affordance to add a new
 * project via the directory picker.
 */
function ProjectPopover({
  current,
  anchorRef,
  onClose,
  onSwitched,
  isAddingProject,
  setIsAddingProject,
}: {
  current: string | null;
  /** Anchor (the project avatar) — clicks on it are ignored so it can toggle. */
  anchorRef: React.RefObject<HTMLElement | null>;
  onClose: () => void;
  /** Called after the active project changed, so the host can refresh + close. */
  onSwitched: () => void;
  isAddingProject: boolean;
  setIsAddingProject: (isAdding: boolean) => void;
}) {
  const ref = useRef<HTMLDivElement | null>(null);
  const [projects, setProjects] = useState<ProjectListEntry[]>([]);
  const [addProjectError, setAddProjectError] = useState<string | null>(null);

  useEffect(() => {
    function onDocClick(e: MouseEvent) {
      const target = e.target as Node;
      // Ignore clicks inside the popover or on the anchor (the anchor toggles).
      if (ref.current && ref.current.contains(target)) return;
      if (anchorRef.current && anchorRef.current.contains(target)) return;
      onClose();
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    document.addEventListener("mousedown", onDocClick);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDocClick);
      document.removeEventListener("keydown", onKey);
    };
  }, [onClose, anchorRef]);

  const loadProjects = useCallback(async () => {
    try {
      const result = await commands.getProjects();
      if (result.status === "ok") {
        setProjects(result.data.map((p) => ({ slug: p.slug, path: p.path })));
      }
    } catch {
      setProjects([]);
    }
  }, []);

  useEffect(() => {
    void loadProjects();
  }, [loadProjects]);

  const handleSelect = useCallback(
    async (entry: ProjectListEntry) => {
      if (isAddingProject) return;

      // Selecting the active project is a no-op — just close.
      if (entry.slug === current) {
        onClose();
        return;
      }
      try {
        const result = await commands.setCurrentProject(entry.slug);
        if (result.status === "ok") {
          resetProjectScopedStores();
          onSwitched();
        }
      } catch {
        // Swallow — leave the popover open so the user can retry.
      }
    },
    [current, isAddingProject, onClose, onSwitched]
  );

  const handleAddProject = useCallback(async () => {
    if (isAddingProject) return;

    setIsAddingProject(true);
    setAddProjectError(null);
    try {
      const selected = await open({
        directory: true,
        multiple: false,
        title: "Select Project Directory",
      });
      if (selected && typeof selected === "string") {
        const result = await commands.initializeProject(selected, null);
        if (result.status === "ok") {
          await loadProjects();
          resetProjectScopedStores();
        } else {
          setAddProjectError(result.error.message);
        }
      }
    } catch (error) {
      setAddProjectError(
        error instanceof Error ? error.message : "Failed to add project"
      );
    } finally {
      setIsAddingProject(false);
    }
  }, [isAddingProject, loadProjects, setIsAddingProject]);

  return (
    <div
      ref={ref}
      role="dialog"
      aria-label="Switch project"
      data-testid="sidebar-project-switcher"
      className={[
        "absolute left-12 top-14 z-50 w-[220px]",
        "rounded-[var(--radius-lg)] border border-[var(--color-line-strong)]",
        "bg-[var(--color-bg-3)] shadow-[var(--shadow-2)] py-1",
      ].join(" ")}
    >
      {projects.length === 0 ? (
        <div className="px-3 py-2 text-xs text-[var(--color-fg-mute)]">
          No recent projects
        </div>
      ) : (
        projects.map((p) => {
          const isActive = p.slug === current;
          return (
            <button
              key={p.path}
              type="button"
              onClick={() => handleSelect(p)}
              disabled={isAddingProject}
              aria-current={isActive ? "true" : undefined}
              data-testid={`sidebar-project-entry-${p.slug}`}
              className={[
                "flex w-full items-center justify-between gap-2 px-3 py-2",
                "text-left text-sm text-[var(--color-fg)]",
                isActive ? "cursor-default" : "hover:bg-[var(--color-bg-2)]",
                "disabled:cursor-wait disabled:opacity-60",
              ].join(" ")}
            >
              <span className="min-w-0 truncate font-sans">{p.slug}</span>
              {isActive && (
                <span
                  aria-label="Active project"
                  className="text-[var(--color-accent)]"
                >
                  ✓
                </span>
              )}
            </button>
          );
        })
      )}
      <div className="my-1 h-px bg-[var(--color-line)]" />
      <button
        type="button"
        onClick={handleAddProject}
        disabled={isAddingProject}
        aria-label="Add a project"
        data-testid="sidebar-add-project"
        className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm text-[var(--color-fg)] hover:bg-[var(--color-bg-2)] disabled:cursor-wait disabled:opacity-60"
      >
        <span
          aria-hidden
          className="flex h-5 w-5 shrink-0 items-center justify-center rounded-[var(--radius-sm)] border border-[var(--color-line-strong)] text-[var(--color-fg-mute)]"
        >
          +
        </span>
        Add project…
      </button>
      {addProjectError && (
        <p role="alert" className="px-3 pb-2 text-xs text-[var(--color-err)]">
          {addProjectError}
        </p>
      )}
    </div>
  );
}

function railStatusConfig(status: WebSocketStatus): {
  dot: string;
  glow: string;
  label: string;
  name: string;
  token: "ok" | "warn" | "err";
} {
  switch (status) {
    case "connected":
      return {
        dot: "bg-[var(--color-ok)]",
        glow: "shadow-[0_0_6px_color-mix(in_oklch,var(--color-ok)_60%,transparent)]",
        label: "connected",
        name: "Connected",
        token: "ok",
      };
    case "connecting":
    case "reconnecting":
      return {
        dot: "bg-[var(--color-warn)]",
        glow: "shadow-[0_0_6px_color-mix(in_oklch,var(--color-warn)_60%,transparent)]",
        label: "connecting",
        name: status === "reconnecting" ? "Reconnecting" : "Connecting",
        token: "warn",
      };
    case "disconnected":
    default:
      return {
        dot: "bg-[var(--color-err)]",
        glow: "shadow-[0_0_6px_color-mix(in_oklch,var(--color-err)_60%,transparent)]",
        label: "disconnected",
        name: "Disconnected",
        token: "err",
      };
  }
}

function RailConnectionStatus() {
  const status = useWebSocketStatus();
  const config = railStatusConfig(status);
  const accessibleName = `WebSocket: ${config.name}`;

  return (
    <div
      role="status"
      title={accessibleName}
      aria-label={accessibleName}
      data-testid="rail-connection-status"
      className="mt-auto flex flex-col items-center gap-1.5 pb-1.5 font-mono text-[length:var(--text-9)] uppercase tracking-[0.08em] text-[var(--color-fg-faint)] [writing-mode:vertical-rl] rotate-180"
    >
      <span
        aria-hidden
        data-testid="rail-connection-dot"
        data-status-token={config.token}
        className={`h-1.5 w-1.5 rounded-full [writing-mode:horizontal-tb] rotate-180 ${config.dot} ${config.glow}`}
      />
      <span>{config.label}</span>
    </div>
  );
}

const RAIL_NAV_ITEMS = [
  {
    id: "tasks",
    to: "/tasks",
    label: "Tasks",
    icon: (
      <Icon size="sm" strokeWidth={2}>
        <line x1="8" y1="6" x2="21" y2="6" />
        <line x1="8" y1="12" x2="21" y2="12" />
        <line x1="8" y1="18" x2="21" y2="18" />
        {/* Round caps are required for zero-length dot lines to render. */}
        <line x1="3" y1="6" x2="3.01" y2="6" />
        <line x1="3" y1="12" x2="3.01" y2="12" />
        <line x1="3" y1="18" x2="3.01" y2="18" />
      </Icon>
    ),
  },
  {
    id: "board",
    to: "/board",
    label: "Board",
    icon: (
      <Icon size="sm" strokeWidth={2}>
        <rect x="3" y="3" width="7" height="18" rx="1" />
        <rect x="14" y="3" width="7" height="11" rx="1" />
      </Icon>
    ),
  },
  {
    id: "design",
    to: "/design",
    label: "Atlas",
    icon: (
      <Icon size="sm" strokeWidth={2}>
        <circle cx="5" cy="6" r="3" />
        <circle cx="19" cy="6" r="3" />
        <circle cx="12" cy="18" r="3" />
        <path d="m7 8 4 8M17 8l-4 8" />
      </Icon>
    ),
  },
  {
    id: "traces",
    to: "/traces",
    label: "Traces",
    icon: (
      <Icon size="sm" strokeWidth={2}>
        <path d="M3 12h4l3-9 4 18 3-9h4" />
      </Icon>
    ),
  },
] as const;

/**
 * Application sidebar. 48px fixed width, icon-only nav, project avatar at top,
 * project chat and theme toggle pinned to the bottom.
 */
export function Sidebar() {
  const project = useCurrentProject();
  const navigate = useNavigate();
  const [switcherOpen, setSwitcherOpen] = useState(false);
  const [isAddingProject, setIsAddingProject] = useState(false);
  const avatarRef = useRef<HTMLButtonElement | null>(null);

  function handleSwitched() {
    setSwitcherOpen(false);
    // Switching projects must re-initialize every project-scoped surface — the
    // sidebar avatar (useCurrentProject polls only once on mount), websocket
    // subscriptions, and page data. The old flow got that remount for free by
    // routing through the top-level /setup page; an in-place switch from the
    // already-mounted shell does not remount anything, so a client-side
    // navigate("/") would leave the avatar stuck on the previous project.
    // Force a full reload to the root instead.
    window.location.assign("/");
  }

  return (
    <aside
      aria-label="Sidebar navigation"
      className={[
        // Uniform 4px gap (`gap-1`) mirrors the design rail's `.app-rail { gap: 4px }`.
        "relative flex w-12 shrink-0 flex-col items-center gap-1 py-1.5",
        "border-r border-[var(--color-line)] bg-[var(--color-bg)]",
      ].join(" ")}
    >
      <div className="relative flex h-7 items-center justify-center">
        {project.name ? (
          <ProjectAvatar
            name={project.name}
            path={project.path ?? project.name}
            onClick={() => setSwitcherOpen((v) => !v)}
            buttonRef={avatarRef}
            disabled={isAddingProject}
          />
        ) : (
          <button
            type="button"
            onClick={() => navigate("/setup")}
            aria-label="Open a project"
            className="flex h-7 w-7 items-center justify-center rounded-[var(--radius-md)] border border-dashed border-[var(--color-line-strong)] text-[var(--color-fg-mute)] hover:text-[var(--color-accent)]"
          >
            +
          </button>
        )}
        {switcherOpen && (
          <ProjectPopover
            current={project.name}
            anchorRef={avatarRef}
            onClose={() => {
              if (!isAddingProject) setSwitcherOpen(false);
            }}
            onSwitched={handleSwitched}
            isAddingProject={isAddingProject}
            setIsAddingProject={setIsAddingProject}
          />
        )}
      </div>
      {/* Thin 20px rule between the project monogram and the nav icons —
          the design rail's `.app-rail hr` (1px, --color-line, 20px wide). */}
      <div
        aria-hidden
        className="my-0.5 h-px w-5 shrink-0 bg-[var(--color-line)]"
      />
      <nav aria-label="Main navigation" className="flex-1">
        <ul role="list" className="flex flex-col items-center gap-1">
          {RAIL_NAV_ITEMS.map((item) => (
            <NavItem key={item.id} {...item} />
          ))}
        </ul>
      </nav>
      <div className="flex flex-col items-center gap-1 pb-1">
        <ThemeToggle />
      </div>
      <RailConnectionStatus />
    </aside>
  );
}

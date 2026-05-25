import { useCallback, useEffect, useRef, useState } from "react";
import { NavLink, useLocation, useNavigate } from "react-router-dom";
import { commands } from "../bindings";
import { useChatStore } from "../stores/chatStore";
import { useShellStore } from "../stores/shellStore";
import { useOpenChat } from "../hooks/useScopedChat";
import { useStyleguideStore } from "../stores/styleguideStore";
import {
  useCurrentProject,
  projectAvatarBucket,
} from "../hooks/useCurrentProject";
import { resetProjectScopedStores } from "../stores";
import { open } from "@tauri-apps/plugin-dialog";
import { Tooltip } from "./atoms/Tooltip";
import { ThemeToggle } from "./ThemeToggle";

interface NavItemProps {
  to: string;
  label: string;
  icon: React.ReactNode;
  /** Render a small dot in the corner — used for unread/needs-attention. */
  withDot?: boolean;
}

function NavItem({ to, label, icon, withDot }: NavItemProps) {
  return (
    <li>
      <NavLink
        to={to}
        data-testid={`sidebar-nav-${label.toLowerCase().replace(/\s+/g, "-")}`}
        title={label}
        aria-label={label}
        className={({ isActive }) =>
          [
            "group relative flex h-9 w-9 items-center justify-center rounded-[var(--radius-md)]",
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
                className="absolute left-[-6px] top-1/2 h-5 w-0.5 -translate-y-1/2 rounded-r bg-[var(--color-accent)]"
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
}: {
  name: string;
  path: string;
  onClick: () => void;
  buttonRef?: React.Ref<HTMLButtonElement>;
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
        aria-label={`Switch project · ${name}`}
        data-testid="sidebar-project-avatar"
        className={[
          "flex h-7 w-7 items-center justify-center rounded-[var(--radius-md)]",
          // Project monogram is part of the Hearth wordmark family — serif
          // italic (Newsreader), not the mono UI numerals.
          "font-serif text-[15px] italic text-white",
          "ring-0 transition-shadow duration-[var(--t-fast)] hover:ring-2 hover:ring-[var(--color-accent-wash)]",
          palette[bucket],
        ].join(" ")}
      >
        {name.charAt(0).toUpperCase()}
      </button>
    </Tooltip>
  );
}

function ProjectChatButton() {
  const openChat = useOpenChat();
  const panelOpen = useChatStore((s) => s.panelOpen);
  const handleClick = useCallback(() => {
    openChat("project", null, "Project Chat");
  }, [openChat]);

  return (
    <Tooltip label="Project Chat" placement="right">
      <button
        type="button"
        onClick={handleClick}
        aria-label="Project Chat"
        className={[
          "group relative flex h-9 w-9 items-center justify-center rounded-[var(--radius-md)]",
          "transition-[background-color,color] duration-[var(--t-fast)] ease-[var(--ease-default)]",
          "focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-accent)]",
          panelOpen
            ? "bg-[var(--color-accent-wash)] text-[var(--color-accent)]"
            : "text-[var(--color-fg-mute)] hover:bg-[var(--color-bg-1)] hover:text-[var(--color-fg)]",
        ].join(" ")}
      >
        <svg
          width={18}
          height={18}
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth={1.6}
          aria-hidden
        >
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            d="M17 8h2a2 2 0 012 2v6a2 2 0 01-2 2h-2v4l-4-4H9a1.994 1.994 0 01-1.414-.586m0 0L11 14h4a2 2 0 002-2V6a2 2 0 00-2-2H5a2 2 0 00-2 2v6a2 2 0 002 2h2v4l.586-.586z"
          />
        </svg>
      </button>
    </Tooltip>
  );
}

function StyleguideNavItem() {
  const location = useLocation();
  const isVisible = useStyleguideStore((s) => s.isStyleguideNavVisible);
  const show = isVisible || location.pathname === "/styleguide";
  if (!show) return null;
  return (
    <NavItem
      to="/styleguide"
      label="Styleguide"
      icon={
        <svg
          width={18}
          height={18}
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth={1.6}
          aria-hidden
        >
          <path d="M4 5a2 2 0 012-2h4l2 2h6a2 2 0 012 2v2H4V5z" />
          <path d="M4 9h16v8a2 2 0 01-2 2H6a2 2 0 01-2-2V9zM8 13h3m-3 3h8" />
        </svg>
      }
    />
  );
}

/**
 * Vertebrae logo mark — stylised spine with copper ember glow.
 */
function LogoMark() {
  return (
    <div className="relative flex h-7 w-7 items-center justify-center">
      <svg
        viewBox="0 0 24 24"
        width={22}
        height={22}
        fill="none"
        stroke="currentColor"
        strokeWidth={1.6}
        className="relative text-[var(--color-accent)]"
        aria-label="Vertebrae"
      >
        <path
          strokeLinecap="round"
          strokeLinejoin="round"
          d="M12 2v20M12 6c-2 0-3.5 1-3.5 2s1.5 2 3.5 2 3.5-1 3.5-2-1.5-2-3.5-2z"
        />
        <path
          strokeLinecap="round"
          strokeLinejoin="round"
          d="M12 10c-2 0-3.5 1-3.5 2s1.5 2 3.5 2 3.5-1 3.5-2-1.5-2-3.5-2z"
        />
        <path
          strokeLinecap="round"
          strokeLinejoin="round"
          d="M12 14c-2 0-3.5 1-3.5 2s1.5 2 3.5 2 3.5-1 3.5-2-1.5-2-3.5-2z"
        />
      </svg>
      <span
        aria-hidden
        className="absolute inset-0 rounded-full bg-[var(--color-accent)] opacity-20 blur-md"
      />
    </div>
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
}: {
  current: string | null;
  /** Anchor (the project avatar) — clicks on it are ignored so it can toggle. */
  anchorRef: React.RefObject<HTMLElement | null>;
  onClose: () => void;
  /** Called after the active project changed, so the host can refresh + close. */
  onSwitched: () => void;
}) {
  const ref = useRef<HTMLDivElement | null>(null);
  const [projects, setProjects] = useState<ProjectListEntry[]>([]);

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
        setProjects(
          result.data.map((p) => ({ slug: p.slug, path: p.path })),
        );
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
    [current, onClose, onSwitched],
  );

  const handleAddProject = useCallback(async () => {
    try {
      const selected = await open({
        directory: true,
        multiple: false,
        title: "Select Project Directory",
      });
      if (selected && typeof selected === "string") {
        const result = await commands.addProject(selected);
        if (result.status === "ok") {
          await loadProjects();
        }
      }
    } catch {
      // Swallow — leave the popover open so the user can retry.
    }
  }, [loadProjects]);

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
              aria-current={isActive ? "true" : undefined}
              data-testid={`sidebar-project-entry-${p.slug}`}
              className={[
                "flex w-full items-center justify-between gap-2 px-3 py-2",
                "text-left text-sm text-[var(--color-fg)]",
                isActive ? "cursor-default" : "hover:bg-[var(--color-bg-2)]",
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
        aria-label="Add a project"
        data-testid="sidebar-add-project"
        className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm text-[var(--color-fg)] hover:bg-[var(--color-bg-2)]"
      >
        <span
          aria-hidden
          className="flex h-5 w-5 shrink-0 items-center justify-center rounded-[var(--radius-sm)] border border-[var(--color-line-strong)] text-[var(--color-fg-mute)]"
        >
          +
        </span>
        Add project…
      </button>
    </div>
  );
}

/**
 * Application sidebar. 48px fixed width, icon-only nav, project avatar at top,
 * project chat and theme toggle pinned to the bottom.
 */
export function Sidebar() {
  const project = useCurrentProject();
  const navigate = useNavigate();
  const [switcherOpen, setSwitcherOpen] = useState(false);
  const avatarRef = useRef<HTMLButtonElement | null>(null);
  const needsAttention = useShellStore((s) => s.needsAttentionCount > 0);

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
        "relative flex w-12 shrink-0 flex-col items-center gap-2 py-1.5",
        "border-r border-[var(--color-line)] bg-[var(--color-bg)]",
      ].join(" ")}
    >
      <div className="flex h-9 items-center justify-center">
        <LogoMark />
      </div>
      <div className="h-px w-7 bg-[var(--color-line)]" aria-hidden />
      <div className="relative flex h-9 items-center justify-center">
        {project.name ? (
          <ProjectAvatar
            name={project.name}
            path={project.path ?? project.name}
            onClick={() => setSwitcherOpen((v) => !v)}
            buttonRef={avatarRef}
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
            onClose={() => setSwitcherOpen(false)}
            onSwitched={handleSwitched}
          />
        )}
      </div>
      <div className="h-px w-7 bg-[var(--color-line)]" aria-hidden />
      <nav aria-label="Main navigation" className="flex-1">
        <ul role="list" className="flex flex-col items-center gap-1">
          <NavItem
            to="/operations"
            label="Operations"
            withDot={needsAttention}
            icon={
              <svg
                width={18}
                height={18}
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth={1.6}
                aria-hidden
              >
                <path d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.066 2.573c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.573 1.066c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.066-2.573c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z" />
                <path d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
              </svg>
            }
          />
          <NavItem
            to="/board"
            label="Board"
            icon={
              <svg
                width={18}
                height={18}
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth={1.6}
                aria-hidden
              >
                <path d="M9 17V7m0 10a2 2 0 01-2 2H5a2 2 0 01-2-2V7a2 2 0 012-2h2a2 2 0 012 2m0 10a2 2 0 002 2h2a2 2 0 002-2M9 7a2 2 0 012-2h2a2 2 0 012 2m0 10V7m0 10a2 2 0 002 2h2a2 2 0 002-2V7a2 2 0 00-2-2h-2a2 2 0 00-2 2" />
              </svg>
            }
          />
          <NavItem
            to="/design"
            label="Design"
            icon={
              <svg
                width={18}
                height={18}
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth={1.6}
                aria-hidden
              >
                <path d="M13 10V3L4 14h7v7l9-11h-7z" />
              </svg>
            }
          />
          <li aria-hidden className="my-1 h-px w-5 bg-[var(--color-line)]" />
          <NavItem
            to="/tasks"
            label="Tasks"
            icon={
              <svg
                width={18}
                height={18}
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth={1.6}
                aria-hidden
              >
                <path d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2m-6 9l2 2 4-4" />
              </svg>
            }
          />
          <NavItem
            to="/traces"
            label="Traces"
            icon={
              <svg
                width={18}
                height={18}
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth={1.6}
                aria-hidden
              >
                <path d="M4 6h6m0 0a2 2 0 104 0 2 2 0 00-4 0zm0 0v12m4-6h6m-6 0a2 2 0 104 0 2 2 0 00-4 0zm-4 6h6m-6 0a2 2 0 104 0 2 2 0 00-4 0z" />
              </svg>
            }
          />
          <StyleguideNavItem />
        </ul>
      </nav>
      <div className="flex flex-col items-center gap-1 pb-1">
        <ProjectChatButton />
        <ThemeToggle />
      </div>
    </aside>
  );
}

import { useCallback, useEffect, useState } from "react";
import { NavLink, useNavigate } from "react-router-dom";
import { commands } from "../bindings";
import { useChatStore } from "../stores/chatStore";
import { useOpenChat } from "../hooks/useScopedChat";

interface NavItemProps {
  to: string;
  icon: React.ReactNode;
  label: string;
}

/**
 * Navigation item with neural pulse effect on active state
 */
function NavItem({ to, icon, label }: NavItemProps) {
  return (
    <li>
      <NavLink
        to={to}
        data-testid={`sidebar-nav-${label.toLowerCase().replace(/\s+/g, "-")}`}
        className={({ isActive }) =>
          `group relative flex items-center justify-center rounded-lg p-2.5 text-sm font-medium transition-all duration-200 focus:outline-none focus-visible:ring-2 focus-visible:ring-primary ${
            isActive
              ? "bg-primary/10 text-primary shadow-glow-sm"
              : "text-text-secondary hover:bg-bg-hover hover:text-text-primary"
          }`
        }
        title={label}
      >
        {({ isActive }) => (
          <>
            {/* Glow indicator for active state */}
            {isActive && (
              <span className="absolute left-0 top-1/2 h-6 w-0.5 -translate-y-1/2 rounded-full bg-primary shadow-glow-sm" />
            )}
            <span
              className={`relative shrink-0 transition-transform duration-200 ${isActive ? "scale-110" : "group-hover:scale-105"}`}
            >
              {icon}
            </span>
          </>
        )}
      </NavLink>
    </li>
  );
}

/**
 * Project switcher component that shows current project icon and allows switching
 */
function ProjectSwitcher() {
  const navigate = useNavigate();
  const [projectName, setProjectName] = useState<string | null>(null);

  useEffect(() => {
    async function loadCurrentProject() {
      try {
        const result = await commands.getCurrentProject();
        if (result.status === "ok" && result.data) {
          // Extract project name from path
          const parts = result.data.split("/");
          setProjectName(parts[parts.length - 1] || "Unknown");
        }
      } catch {
        // Ignore errors
      }
    }
    loadCurrentProject();
  }, []);

  const handleClick = () => {
    navigate("/setup");
  };

  if (!projectName) return null;

  return (
    <button
      onClick={handleClick}
      className="flex w-full items-center justify-center border-b border-border px-4 py-3 transition-colors hover:bg-bg-hover"
      title={`Switch project: ${projectName}`}
    >
      {/* Folder icon */}
      <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-primary/10">
        <svg
          className="h-4 w-4 text-primary"
          fill="none"
          stroke="currentColor"
          viewBox="0 0 24 24"
          aria-hidden="true"
        >
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeWidth={1.5}
            d="M3 7v10a2 2 0 002 2h14a2 2 0 002-2V9a2 2 0 00-2-2h-6l-2-2H5a2 2 0 00-2 2z"
          />
        </svg>
      </div>
    </button>
  );
}

/**
 * Project chat button that opens a project-scoped chat in the ChatWindowManager
 */
function ProjectChatButton() {
  const openChat = useOpenChat();
  const panelOpen = useChatStore((s) => s.panelOpen);

  const handleClick = useCallback(() => {
    openChat("project", null, "Project Chat");
  }, [openChat]);

  return (
    <li>
      <button
        onClick={handleClick}
        className={`group relative flex w-full items-center justify-center rounded-lg p-2.5 text-sm font-medium transition-all duration-200 focus:outline-none focus-visible:ring-2 focus-visible:ring-primary ${
          panelOpen
            ? "bg-accent/10 text-accent shadow-glow-sm"
            : "text-text-secondary hover:bg-bg-hover hover:text-text-primary"
        }`}
        title="Project Chat"
      >
        {panelOpen && (
          <span className="absolute left-0 top-1/2 h-6 w-0.5 -translate-y-1/2 rounded-full bg-accent shadow-glow-sm" />
        )}
        <span
          className={`relative shrink-0 transition-transform duration-200 ${panelOpen ? "scale-110" : "group-hover:scale-105"}`}
        >
          <svg
            className="h-5 w-5"
            fill="none"
            stroke="currentColor"
            viewBox="0 0 24 24"
            aria-hidden="true"
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth={1.5}
              d="M17 8h2a2 2 0 012 2v6a2 2 0 01-2 2h-2v4l-4-4H9a1.994 1.994 0 01-1.414-.586m0 0L11 14h4a2 2 0 002-2V6a2 2 0 00-2-2H5a2 2 0 00-2 2v6a2 2 0 002 2h2v4l.586-.586z"
            />
          </svg>
        </span>
      </button>
    </li>
  );
}

/**
 * Sidebar navigation with neural pathway aesthetic.
 * Always collapsed, showing only icons.
 */
export function Sidebar() {
  return (
    <aside
      className="relative flex w-16 flex-col border-r border-border bg-bg-secondary"
      aria-label="Sidebar navigation"
    >
      {/* Neural grid background */}
      <div className="neural-grid pointer-events-none absolute inset-0 opacity-30" />

      {/* Logo/Brand area */}
      <div className="relative flex h-14 items-center justify-center border-b border-border">
        {/* Vertebrae logo mark */}
        <div className="relative flex h-8 w-8 items-center justify-center">
          {/* Spine/vertebrae icon - orange accent */}
          <svg
            className="h-6 w-6 text-accent"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.5"
            aria-hidden="true"
          >
            {/* Stylized spine/neural path */}
            <path
              d="M12 2v20M12 6c-2 0-3.5 1-3.5 2s1.5 2 3.5 2 3.5-1 3.5-2-1.5-2-3.5-2z"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
            <path
              d="M12 10c-2 0-3.5 1-3.5 2s1.5 2 3.5 2 3.5-1 3.5-2-1.5-2-3.5-2z"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
            <path
              d="M12 14c-2 0-3.5 1-3.5 2s1.5 2 3.5 2 3.5-1 3.5-2-1.5-2-3.5-2z"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
          {/* Orange glow behind icon */}
          <div className="absolute inset-0 rounded-full bg-accent/20 blur-md" />
        </div>
      </div>

      {/* Project Switcher */}
      <ProjectSwitcher />

      {/* Navigation */}
      <nav
        className="relative flex-1 overflow-y-auto p-3"
        aria-label="Main navigation"
      >
        <ul className="space-y-1" role="list">
          <NavItem
            to="/operations"
            label="Operations"
            icon={
              <svg
                className="h-5 w-5"
                fill="none"
                stroke="currentColor"
                viewBox="0 0 24 24"
                aria-hidden="true"
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={1.5}
                  d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.066 2.573c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.573 1.066c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.066-2.573c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z"
                />
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={1.5}
                  d="M15 12a3 3 0 11-6 0 3 3 0 016 0z"
                />
              </svg>
            }
          />
          <NavItem
            to="/board"
            label="Board"
            icon={
              <svg
                className="h-5 w-5"
                fill="none"
                stroke="currentColor"
                viewBox="0 0 24 24"
                aria-hidden="true"
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={1.5}
                  d="M9 17V7m0 10a2 2 0 01-2 2H5a2 2 0 01-2-2V7a2 2 0 012-2h2a2 2 0 012 2m0 10a2 2 0 002 2h2a2 2 0 002-2M9 7a2 2 0 012-2h2a2 2 0 012 2m0 10V7m0 10a2 2 0 002 2h2a2 2 0 002-2V7a2 2 0 00-2-2h-2a2 2 0 00-2 2"
                />
              </svg>
            }
          />

          {/* Separator between Board and Design */}
          <li aria-hidden="true">
            <div className="my-2 border-t border-border" />
          </li>

          <NavItem
            to="/design"
            label="Design"
            icon={
              <svg
                className="h-5 w-5"
                fill="none"
                stroke="currentColor"
                viewBox="0 0 24 24"
                aria-hidden="true"
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={1.5}
                  d="M13 10V3L4 14h7v7l9-11h-7z"
                />
              </svg>
            }
          />
          <NavItem
            to="/tasks"
            label="Tasks"
            icon={
              <svg
                className="h-5 w-5"
                fill="none"
                stroke="currentColor"
                viewBox="0 0 24 24"
                aria-hidden="true"
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={1.5}
                  d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2m-6 9l2 2 4-4"
                />
              </svg>
            }
          />
          <NavItem
            to="/traces"
            label="Traces"
            icon={
              <svg
                className="h-5 w-5"
                fill="none"
                stroke="currentColor"
                viewBox="0 0 24 24"
                aria-hidden="true"
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={1.5}
                  d="M4 6h6m0 0a2 2 0 104 0 2 2 0 00-4 0zm0 0v12m4-6h6m-6 0a2 2 0 104 0 2 2 0 00-4 0zm-4 6h6m-6 0a2 2 0 104 0 2 2 0 00-4 0z"
                />
              </svg>
            }
          />
          <ProjectChatButton />
        </ul>
      </nav>
    </aside>
  );
}

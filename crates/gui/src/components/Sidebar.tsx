import { useEffect, useState } from "react";
import { NavLink, useNavigate } from "react-router-dom";
import { commands } from "../bindings";
import { useChatStore, useUIStore } from "../stores";

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
 * Chat toggle button that opens/closes the chat panel
 */
function ChatToggleButton() {
  const toggleChatPanel = useUIStore((s) => s.toggleChatPanel);
  const chatPanelOpen = useUIStore((s) => s.chatPanelOpen);
  const isChatActive = useChatStore((s) => s.sessionState === "running");

  return (
    <li>
      <button
        onClick={toggleChatPanel}
        className={`group relative flex w-full items-center justify-center rounded-lg p-2.5 text-sm font-medium transition-all duration-200 focus:outline-none focus-visible:ring-2 focus-visible:ring-primary ${
          chatPanelOpen
            ? "bg-primary/10 text-primary shadow-glow-sm"
            : "text-text-secondary hover:bg-bg-hover hover:text-text-primary"
        }`}
        title={chatPanelOpen ? "Hide Terminal" : "Show Terminal"}
      >
        {/* Glow indicator for active state */}
        {chatPanelOpen && (
          <span className="absolute left-0 top-1/2 h-6 w-0.5 -translate-y-1/2 rounded-full bg-primary shadow-glow-sm" />
        )}
        <span
          className={`relative shrink-0 transition-transform duration-200 ${chatPanelOpen ? "scale-110" : "group-hover:scale-105"}`}
        >
          {/* Terminal icon */}
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
              d="M8 9l3 3-3 3m5 0h3M5 20h14a2 2 0 002-2V6a2 2 0 00-2-2H5a2 2 0 00-2 2v12a2 2 0 002 2z"
            />
          </svg>
          {/* Active session indicator (pulsing dot) */}
          {isChatActive && (
            <span className="absolute -right-0.5 -top-0.5 flex h-2.5 w-2.5">
              <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-success opacity-75" />
              <span className="relative inline-flex h-2.5 w-2.5 rounded-full bg-success" />
            </span>
          )}
        </span>
      </button>
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
            to="/"
            label="Pipeline"
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
          <ChatToggleButton />
        </ul>
      </nav>
    </aside>
  );
}

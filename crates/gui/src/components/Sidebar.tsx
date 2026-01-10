import { useCallback } from "react";

interface SidebarProps {
  isCollapsed: boolean;
  onToggle: () => void;
}

export function Sidebar({ isCollapsed, onToggle }: SidebarProps) {
  const handleKeyDown = useCallback(
    (event: React.KeyboardEvent) => {
      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        onToggle();
      }
    },
    [onToggle]
  );

  return (
    <aside
      className={`flex flex-col border-r border-border bg-bg-primary transition-all duration-200 ${
        isCollapsed ? "w-16" : "w-64"
      }`}
      aria-label="Sidebar navigation"
    >
      <div className="flex h-14 items-center justify-end border-b border-border px-3">
        <button
          type="button"
          onClick={onToggle}
          onKeyDown={handleKeyDown}
          className="flex h-8 w-8 items-center justify-center rounded-md text-text-secondary transition-colors hover:bg-bg-tertiary hover:text-text-primary focus:outline-none focus:ring-2 focus:ring-border-focus"
          aria-label={isCollapsed ? "Expand sidebar" : "Collapse sidebar"}
          aria-expanded={!isCollapsed}
        >
          <svg
            className={`h-5 w-5 transition-transform duration-200 ${
              isCollapsed ? "rotate-180" : ""
            }`}
            fill="none"
            stroke="currentColor"
            viewBox="0 0 24 24"
            aria-hidden="true"
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth={2}
              d="M11 19l-7-7 7-7m8 14l-7-7 7-7"
            />
          </svg>
        </button>
      </div>

      <nav className="flex-1 overflow-y-auto p-3" aria-label="Main navigation">
        <ul className="space-y-1" role="list">
          <li>
            <a
              href="#dashboard"
              className="flex items-center gap-3 rounded-md px-3 py-2 text-sm font-medium text-text-secondary transition-colors hover:bg-bg-tertiary hover:text-text-primary focus:outline-none focus:ring-2 focus:ring-border-focus"
            >
              <svg
                className="h-5 w-5 shrink-0"
                fill="none"
                stroke="currentColor"
                viewBox="0 0 24 24"
                aria-hidden="true"
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={2}
                  d="M3 12l2-2m0 0l7-7 7 7M5 10v10a1 1 0 001 1h3m10-11l2 2m-2-2v10a1 1 0 01-1 1h-3m-6 0a1 1 0 001-1v-4a1 1 0 011-1h2a1 1 0 011 1v4a1 1 0 001 1m-6 0h6"
                />
              </svg>
              {!isCollapsed && <span>Dashboard</span>}
            </a>
          </li>
          <li>
            <a
              href="#tasks"
              className="flex items-center gap-3 rounded-md px-3 py-2 text-sm font-medium text-text-secondary transition-colors hover:bg-bg-tertiary hover:text-text-primary focus:outline-none focus:ring-2 focus:ring-border-focus"
            >
              <svg
                className="h-5 w-5 shrink-0"
                fill="none"
                stroke="currentColor"
                viewBox="0 0 24 24"
                aria-hidden="true"
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={2}
                  d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2m-6 9l2 2 4-4"
                />
              </svg>
              {!isCollapsed && <span>Tasks</span>}
            </a>
          </li>
          <li>
            <a
              href="#settings"
              className="flex items-center gap-3 rounded-md px-3 py-2 text-sm font-medium text-text-secondary transition-colors hover:bg-bg-tertiary hover:text-text-primary focus:outline-none focus:ring-2 focus:ring-border-focus"
            >
              <svg
                className="h-5 w-5 shrink-0"
                fill="none"
                stroke="currentColor"
                viewBox="0 0 24 24"
                aria-hidden="true"
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={2}
                  d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z"
                />
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={2}
                  d="M15 12a3 3 0 11-6 0 3 3 0 016 0z"
                />
              </svg>
              {!isCollapsed && <span>Settings</span>}
            </a>
          </li>
        </ul>
      </nav>
    </aside>
  );
}

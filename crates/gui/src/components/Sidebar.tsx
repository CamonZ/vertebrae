import { useCallback } from 'react';
import { NavLink } from 'react-router-dom';

interface SidebarProps {
  isCollapsed: boolean;
  onToggle: () => void;
}

interface NavItemProps {
  to: string;
  icon: React.ReactNode;
  label: string;
  isCollapsed: boolean;
}

/**
 * Navigation item with neural pulse effect on active state
 */
function NavItem({ to, icon, label, isCollapsed }: NavItemProps) {
  return (
    <li>
      <NavLink
        to={to}
        className={({ isActive }) =>
          `group relative flex items-center gap-3 rounded-lg px-3 py-2.5 text-sm font-medium transition-all duration-200 focus:outline-none focus-visible:ring-2 focus-visible:ring-primary ${
            isActive
              ? 'bg-primary/10 text-primary shadow-glow-sm'
              : 'text-text-secondary hover:bg-bg-hover hover:text-text-primary'
          }`
        }
      >
        {({ isActive }) => (
          <>
            {/* Glow indicator for active state */}
            {isActive && (
              <span className="absolute left-0 top-1/2 h-6 w-0.5 -translate-y-1/2 rounded-full bg-primary shadow-glow-sm" />
            )}
            <span className={`shrink-0 transition-transform duration-200 ${isActive ? 'scale-110' : 'group-hover:scale-105'}`}>
              {icon}
            </span>
            {!isCollapsed && (
              <span className="truncate">{label}</span>
            )}
          </>
        )}
      </NavLink>
    </li>
  );
}

/**
 * Sidebar navigation with neural pathway aesthetic.
 * Features collapsible state, glowing active indicators, and subtle grid background.
 */
export function Sidebar({ isCollapsed, onToggle }: SidebarProps) {
  const handleKeyDown = useCallback(
    (event: React.KeyboardEvent) => {
      if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault();
        onToggle();
      }
    },
    [onToggle]
  );

  return (
    <aside
      className={`relative flex flex-col border-r border-border bg-bg-secondary transition-all duration-300 ease-out ${
        isCollapsed ? 'w-16' : 'w-60'
      }`}
      aria-label="Sidebar navigation"
    >
      {/* Neural grid background */}
      <div className="neural-grid pointer-events-none absolute inset-0 opacity-30" />

      {/* Logo/Brand area */}
      <div className="relative flex h-14 items-center border-b border-border px-4">
        {/* Vertebrae logo mark */}
        <div className="flex items-center gap-3">
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
          {!isCollapsed && (
            <span className="font-mono text-sm font-semibold tracking-tight text-text-primary">
              VERTEBRAE
            </span>
          )}
        </div>
      </div>

      {/* Navigation */}
      <nav className="relative flex-1 overflow-y-auto p-3" aria-label="Main navigation">
        <ul className="space-y-1" role="list">
          <NavItem
            to="/tasks"
            label="Tasks"
            isCollapsed={isCollapsed}
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
            to="/workflows"
            label="Workflows"
            isCollapsed={isCollapsed}
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
        </ul>
      </nav>

      {/* Collapse toggle */}
      <div className="relative border-t border-border p-3">
        <button
          type="button"
          onClick={onToggle}
          onKeyDown={handleKeyDown}
          className={`flex w-full items-center gap-3 rounded-lg px-3 py-2 text-sm text-text-muted transition-all duration-200 hover:bg-bg-hover hover:text-text-secondary focus:outline-none focus-visible:ring-2 focus-visible:ring-primary ${
            isCollapsed ? 'justify-center' : ''
          }`}
          aria-label={isCollapsed ? 'Expand sidebar' : 'Collapse sidebar'}
          aria-expanded={!isCollapsed}
        >
          <svg
            className={`h-4 w-4 transition-transform duration-300 ${
              isCollapsed ? 'rotate-180' : ''
            }`}
            fill="none"
            stroke="currentColor"
            viewBox="0 0 24 24"
            aria-hidden="true"
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth={1.5}
              d="M11 19l-7-7 7-7m8 14l-7-7 7-7"
            />
          </svg>
          {!isCollapsed && <span>Collapse</span>}
        </button>
      </div>
    </aside>
  );
}

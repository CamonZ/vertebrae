import { ThemeToggle } from './ThemeToggle';

interface HeaderProps {
  title: string;
  subtitle?: string;
}

/**
 * Minimal header with context info and controls.
 * The brand is in the sidebar, so this focuses on current context and actions.
 */
export function Header({ title, subtitle }: HeaderProps) {
  return (
    <header
      className="titlebar relative flex h-12 items-center justify-between border-b border-border bg-bg-primary/80 px-6 backdrop-blur-sm"
      role="banner"
    >
      {/* Subtle signal line at bottom */}
      <div className="absolute bottom-0 left-0 right-0 h-px bg-gradient-to-r from-transparent via-primary/20 to-transparent" />

      {/* Context info */}
      <div className="flex items-center gap-3">
        <div>
          <h1 className="text-sm font-medium text-text-primary">{title}</h1>
          {subtitle && (
            <p className="text-xs text-text-muted">{subtitle}</p>
          )}
        </div>
      </div>

      {/* Actions */}
      <div className="titlebar-button flex items-center gap-3">
        <ThemeToggle />
      </div>
    </header>
  );
}

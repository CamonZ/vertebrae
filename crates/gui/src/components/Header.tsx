interface HeaderProps {
  title: string;
  subtitle?: string;
}

export function Header({ title, subtitle }: HeaderProps) {
  return (
    <header
      className="titlebar flex h-14 items-center justify-between border-b border-border bg-bg-primary px-6"
      role="banner"
    >
      <div className="flex items-center gap-4">
        <div>
          <h1 className="text-lg font-semibold text-text-primary">{title}</h1>
          {subtitle && (
            <p className="text-xs text-text-muted">{subtitle}</p>
          )}
        </div>
      </div>

      <div className="titlebar-button flex items-center gap-2">
        <button
          type="button"
          className="flex h-8 w-8 items-center justify-center rounded-md text-text-secondary transition-colors hover:bg-bg-tertiary hover:text-text-primary focus:outline-none focus:ring-2 focus:ring-border-focus"
          aria-label="Notifications"
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
              strokeWidth={2}
              d="M15 17h5l-1.405-1.405A2.032 2.032 0 0118 14.158V11a6.002 6.002 0 00-4-5.659V5a2 2 0 10-4 0v.341C7.67 6.165 6 8.388 6 11v3.159c0 .538-.214 1.055-.595 1.436L4 17h5m6 0v1a3 3 0 11-6 0v-1m6 0H9"
            />
          </svg>
        </button>
        <button
          type="button"
          className="flex h-8 w-8 items-center justify-center rounded-full bg-primary text-sm font-medium text-white transition-colors hover:bg-primary-hover focus:outline-none focus:ring-2 focus:ring-border-focus focus:ring-offset-2"
          aria-label="User menu"
        >
          <span aria-hidden="true">U</span>
        </button>
      </div>
    </header>
  );
}

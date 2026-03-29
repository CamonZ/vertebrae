/**
 * Placeholder page for the Board (Kanban) view.
 * Will be replaced with the full kanban board implementation.
 */
export function BoardPage() {
  return (
    <div className="relative flex flex-1 items-center justify-center">
      {/* Neural grid background */}
      <div className="neural-grid pointer-events-none absolute inset-0 opacity-20" />

      <div className="relative text-center">
        <div className="mb-4 flex justify-center">
          <svg
            className="h-12 w-12 text-text-muted"
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
        </div>
        <h1 className="text-lg font-semibold text-text-primary">Board</h1>
        <p className="mt-2 text-sm text-text-muted">
          Kanban board view coming soon
        </p>
      </div>
    </div>
  );
}

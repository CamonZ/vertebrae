import { useState, type ReactNode } from "react";

interface CollapsibleSectionProps {
  title: string;
  icon?: ReactNode;
  badge?: ReactNode;
  defaultOpen?: boolean;
  children: ReactNode;
  testId?: string;
}

export function CollapsibleSection({
  title,
  icon,
  badge,
  defaultOpen = false,
  children,
  testId,
}: CollapsibleSectionProps) {
  const [isOpen, setIsOpen] = useState(defaultOpen);

  return (
    <div className="border-b border-border" data-testid={testId}>
      <button
        type="button"
        onClick={() => setIsOpen(!isOpen)}
        className="flex w-full items-center justify-between px-4 py-2.5 text-left transition-colors hover:bg-bg-tertiary/50 cursor-pointer"
        aria-expanded={isOpen}
        aria-label={`Toggle ${title} section`}
      >
        <div className="flex items-center gap-2">
          {icon && (
            <span className="text-text-muted" aria-hidden="true">
              {icon}
            </span>
          )}
          <span className="font-mono text-[10px] uppercase tracking-wider text-text-muted">
            {title}
          </span>
          {badge}
        </div>
        <svg
          className={`h-3.5 w-3.5 text-text-muted transition-transform ${isOpen ? "rotate-180" : ""}`}
          fill="none"
          stroke="currentColor"
          viewBox="0 0 24 24"
          aria-hidden="true"
        >
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeWidth={2}
            d="M19 9l-7 7-7-7"
          />
        </svg>
      </button>
      {isOpen && children}
    </div>
  );
}

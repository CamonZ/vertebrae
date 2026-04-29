import { useState, type ReactNode } from "react";
import { SpineRule } from "../SpineRule";

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
    <div data-testid={testId}>
      <button
        type="button"
        onClick={() => setIsOpen(!isOpen)}
        className="flex w-full items-center justify-between px-4 py-3.5 text-left transition-colors hover:bg-bg-hover cursor-pointer"
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
      {isOpen && <div className="pb-6">{children}</div>}
      <div className="px-4 py-3">
        <SpineRule />
      </div>
    </div>
  );
}

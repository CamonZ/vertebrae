import { useCallback, useEffect, useId, useRef, useState } from "react";

export interface OverflowMenuItem {
  key: string;
  label: string;
  /** Accessible name; defaults to `label`. */
  ariaLabel?: string;
  /** Tooltip text, e.g. to surface a keyboard shortcut. */
  title?: string;
  onSelect: () => void;
  disabled?: boolean;
  danger?: boolean;
  pressed?: boolean;
  /** Makes the item a checkbox (role="menuitemcheckbox") with this state. */
  checked?: boolean;
  badge?: number;
  icon?: React.ReactNode;
  testId?: string;
  /** Draw a divider above this item. */
  separatorBefore?: boolean;
}

interface OverflowMenuProps {
  items: OverflowMenuItem[];
  /** Accessible name of the trigger button. */
  label?: string;
  triggerClassName?: string;
  /** Trigger content; defaults to the `⋯` glyph plus the badge total. */
  trigger?: React.ReactNode;
  /** Trigger tooltip; defaults to `label`. */
  triggerTitle?: string;
  testId?: string;
}

/**
 * A `⋯` trigger that reveals secondary actions in a popover menu. Keeps
 * headers to a few visible controls while every action stays reachable.
 * Closes on selection, outside pointer-down, and Escape (focus returns to
 * the trigger).
 */
export function OverflowMenu({
  items,
  label = "More actions",
  triggerClassName = "hc-ctrl",
  trigger,
  triggerTitle,
  testId,
}: OverflowMenuProps) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const menuId = useId();

  const close = useCallback((restoreFocus: boolean) => {
    setOpen(false);
    if (restoreFocus) triggerRef.current?.focus();
  }, []);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent | MouseEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) close(false);
    };
    document.addEventListener("mousedown", onPointerDown);
    return () => document.removeEventListener("mousedown", onPointerDown);
  }, [open, close]);

  useEffect(() => {
    if (!open) return;
    const first = menuRef.current?.querySelector<HTMLButtonElement>(
      '[role^="menuitem"]:not(:disabled)'
    );
    first?.focus();
  }, [open]);

  const onMenuKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      close(true);
      return;
    }
    if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
    event.preventDefault();
    const enabled = Array.from(
      menuRef.current?.querySelectorAll<HTMLButtonElement>(
        '[role^="menuitem"]:not(:disabled)'
      ) ?? []
    );
    if (enabled.length === 0) return;
    const index = enabled.indexOf(document.activeElement as HTMLButtonElement);
    const delta = event.key === "ArrowDown" ? 1 : -1;
    enabled[(index + delta + enabled.length) % enabled.length]?.focus();
  };

  if (items.length === 0) return null;
  const badgeTotal = items.reduce((sum, item) => sum + (item.badge ?? 0), 0);

  return (
    <div className="ovf" ref={rootRef}>
      <button
        ref={triggerRef}
        type="button"
        className={triggerClassName}
        aria-label={label}
        title={triggerTitle ?? label}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        data-testid={testId}
        onClick={() => setOpen((value) => !value)}
      >
        {trigger ?? (
          <>
            <svg
              className="h-3.5 w-3.5"
              viewBox="0 0 24 24"
              fill="currentColor"
              aria-hidden
            >
              <circle cx="5" cy="12" r="1.6" />
              <circle cx="12" cy="12" r="1.6" />
              <circle cx="19" cy="12" r="1.6" />
            </svg>
            {badgeTotal > 0 && (
              <span className="hc-ctrl-badge" aria-hidden>
                {badgeTotal}
              </span>
            )}
          </>
        )}
      </button>
      {open && (
        <div
          ref={menuRef}
          id={menuId}
          role="menu"
          aria-label={label}
          className="ovf-menu"
          onKeyDown={onMenuKeyDown}
        >
          {items.map((item) => (
            <div key={item.key} role="none">
              {item.separatorBefore && (
                <div role="separator" className="ovf-sep" />
              )}
              <button
                type="button"
                role={
                  item.checked === undefined ? "menuitem" : "menuitemcheckbox"
                }
                aria-checked={item.checked}
                className={`ovf-item${item.danger ? " danger" : ""}`}
                aria-label={item.ariaLabel ?? item.label}
                title={item.title}
                aria-pressed={item.pressed}
                disabled={item.disabled}
                data-testid={item.testId}
                onClick={() => {
                  close(true);
                  item.onSelect();
                }}
              >
                <span className="ovf-icon" aria-hidden>
                  {item.icon}
                </span>
                <span className="ovf-label">{item.label}</span>
                {!!item.badge && (
                  <span className="ovf-badge" aria-hidden>
                    {item.badge}
                  </span>
                )}
                {(item.pressed || item.checked) && (
                  <span className="ovf-check" aria-hidden>
                    ✓
                  </span>
                )}
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

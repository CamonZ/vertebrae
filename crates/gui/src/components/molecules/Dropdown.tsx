import { useCallback, useEffect, useId, useRef, useState } from "react";

export interface DropdownOption {
  value: string;
  label: string;
  disabled?: boolean;
  /** CSS colour shown as a dot before the label (colour pickers). */
  swatch?: string;
}

function Swatch({ color }: { color?: string }) {
  if (!color) return null;
  return (
    <span
      aria-hidden="true"
      className="dd-swatch"
      style={{ background: color }}
    />
  );
}

interface DropdownProps {
  options: ReadonlyArray<DropdownOption>;
  value: string;
  onChange: (value: string) => void;
  "aria-label"?: string;
  "data-testid"?: string;
  /** Marks the value as invalid (error edge). */
  invalid?: boolean;
  /** Extra data-* attributes for the trigger button. */
  triggerAttributes?: Record<string, string | undefined>;
  "aria-describedby"?: string;
  id?: string;
  /** `outline` shows a hairline edge; `quiet` shows it only on hover. */
  variant?: "outline" | "quiet";
  /** `chip` sizes to its label; `field` fills a form row. */
  size?: "chip" | "field";
  /** Open below (default) or above the trigger, e.g. in the composer. */
  placement?: "down" | "up";
  /** Align the menu with the trigger's start or end edge. */
  align?: "start" | "end";
  disabled?: boolean;
  className?: string;
}

/**
 * Single-choice picker drawn with the app's own menu (same surface as the ⋯
 * overflow menu) instead of the platform popup, so every dropdown opens the
 * same way. Trigger is a `.ctl` button; the menu is an ARIA listbox with
 * arrow-key navigation, Enter/Space to choose and Escape to dismiss.
 */
export function Dropdown({
  options,
  value,
  onChange,
  "aria-label": ariaLabel,
  "data-testid": testId,
  id,
  variant = "outline",
  size = "chip",
  placement = "down",
  align = "start",
  disabled = false,
  invalid = false,
  triggerAttributes,
  "aria-describedby": ariaDescribedBy,
  className,
}: DropdownProps) {
  const [open, setOpen] = useState(false);
  const selectedIndex = Math.max(
    0,
    options.findIndex((option) => option.value === value)
  );
  const [active, setActive] = useState(selectedIndex);
  const rootRef = useRef<HTMLSpanElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const listRef = useRef<HTMLUListElement>(null);
  const listId = useId();
  const selected = options.find((option) => option.value === value);

  const close = useCallback((refocus: boolean) => {
    setOpen(false);
    if (refocus) triggerRef.current?.focus();
  }, []);

  const openMenu = () => {
    if (disabled) return;
    setActive(selectedIndex);
    setOpen(true);
  };

  useEffect(() => {
    if (!open) return;
    listRef.current?.focus();
    const onPointerDown = (event: MouseEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) close(false);
    };
    document.addEventListener("mousedown", onPointerDown);
    return () => document.removeEventListener("mousedown", onPointerDown);
  }, [open, close]);

  useEffect(() => {
    if (!open) return;
    listRef.current
      ?.querySelector<HTMLElement>(`[data-index="${active}"]`)
      ?.scrollIntoView?.({ block: "nearest" });
  }, [active, open]);

  const move = (delta: number) => {
    if (options.length === 0) return;
    let next = active;
    for (let i = 0; i < options.length; i += 1) {
      next = (next + delta + options.length) % options.length;
      if (!options[next].disabled) break;
    }
    setActive(next);
  };

  const choose = (index: number) => {
    const option = options[index];
    if (!option || option.disabled) return;
    if (option.value !== value) onChange(option.value);
    close(true);
  };

  const onListKeyDown = (event: React.KeyboardEvent) => {
    switch (event.key) {
      case "ArrowDown":
        event.preventDefault();
        move(1);
        break;
      case "ArrowUp":
        event.preventDefault();
        move(-1);
        break;
      case "Home":
        event.preventDefault();
        setActive(0);
        break;
      case "End":
        event.preventDefault();
        setActive(options.length - 1);
        break;
      case "Enter":
      case " ":
        event.preventDefault();
        choose(active);
        break;
      case "Escape":
        event.preventDefault();
        event.stopPropagation();
        close(true);
        break;
      case "Tab":
        close(false);
        break;
    }
  };

  return (
    <span
      ref={rootRef}
      className={[
        "dd",
        size === "field" ? "dd-field" : "",
        className ?? "",
      ]
        .filter(Boolean)
        .join(" ")}
    >
      <button
        ref={triggerRef}
        id={id}
        type="button"
        className={[
          "ctl",
          variant === "quiet" ? "ctl-quiet" : "ctl-outline",
          size === "field" ? "ctl-field" : "",
          "dd-trigger",
        ]
          .filter(Boolean)
          .join(" ")}
        aria-label={ariaLabel}
        aria-invalid={invalid || undefined}
        aria-describedby={ariaDescribedBy}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={open ? listId : undefined}
        {...triggerAttributes}
        data-testid={testId}
        data-value={value}
        disabled={disabled}
        onClick={() => (open ? close(false) : openMenu())}
        onKeyDown={(event) => {
          if (
            event.key === "ArrowDown" ||
            event.key === "ArrowUp" ||
            event.key === "Enter" ||
            event.key === " "
          ) {
            event.preventDefault();
            openMenu();
          }
        }}
      >
        <Swatch color={selected?.swatch} />
        <span className="dd-value">{selected?.label ?? value}</span>
        <span aria-hidden="true" className="ctl-caret" />
      </button>
      {open && (
        <ul
          ref={listRef}
          id={listId}
          role="listbox"
          aria-label={ariaLabel}
          aria-activedescendant={`${listId}-${active}`}
          tabIndex={-1}
          className={[
            "ovf-menu dd-menu",
            placement === "up" ? "up" : "",
            align === "end" ? "end" : "",
          ]
            .filter(Boolean)
            .join(" ")}
          onKeyDown={onListKeyDown}
        >
          {options.map((option, index) => (
            <li
              key={option.value}
              id={`${listId}-${index}`}
              role="option"
              aria-selected={option.value === value}
              aria-disabled={option.disabled || undefined}
              data-index={index}
              data-value={option.value}
              data-active={index === active || undefined}
              className="ovf-item dd-item"
              onMouseMove={() => setActive(index)}
              onClick={(event) => {
                // Inside a <label>, a click would also re-activate the
                // trigger (label activation); cancel that default.
                event.preventDefault();
                choose(index);
              }}
            >
              <Swatch color={option.swatch} />
              <span className="ovf-label">{option.label}</span>
              {option.value === value && (
                <svg
                  aria-hidden="true"
                  viewBox="0 0 24 24"
                  className="dd-check"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth={2.4}
                  strokeLinecap="round"
                  strokeLinejoin="round"
                >
                  <path d="m5 12.5 4.5 4.5L19 7.5" />
                </svg>
              )}
            </li>
          ))}
        </ul>
      )}
    </span>
  );
}

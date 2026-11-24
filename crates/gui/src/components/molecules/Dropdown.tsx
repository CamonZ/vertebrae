import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from "react";

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
  searchPlaceholder?: string;
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
  searchPlaceholder,
}: DropdownProps) {
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState("");
  const visibleOptions = search
    ? options.filter((option) => option.label.toLowerCase().includes(search.trim().toLowerCase()))
    : options;
  const selectedIndex = Math.max(
    0,
    options.findIndex((option) => option.value === value)
  );
  const [active, setActive] = useState(selectedIndex);
  const rootRef = useRef<HTMLSpanElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLUListElement>(null);
  const listId = useId();
  const selected = options.find((option) => option.value === value);

  const close = useCallback((refocus: boolean) => {
    setOpen(false);
    if (refocus) triggerRef.current?.focus({ preventScroll: true });
  }, []);

  const openMenu = () => {
    if (disabled) return;
    setSearch("");
    setActive(searchPlaceholder ? 0 : selectedIndex);
    setOpen(true);
  };

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: MouseEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) close(false);
    };
    document.addEventListener("mousedown", onPointerDown);
    return () => document.removeEventListener("mousedown", onPointerDown);
  }, [open, close]);

  useLayoutEffect(() => {
    const root = rootRef.current;
    const menu = menuRef.current;
    if (!open || !root || !menu) return;

    const positionMenu = () => {
      let top = 0;
      let bottom = window.innerHeight;
      for (let ancestor = root.parentElement; ancestor; ancestor = ancestor.parentElement) {
        if (getComputedStyle(ancestor).overflowY === "visible") continue;
        const bounds = ancestor.getBoundingClientRect();
        const contentTop = bounds.top + ancestor.clientTop;
        top = Math.max(top, contentTop);
        bottom = Math.min(bottom, contentTop + ancestor.clientHeight);
      }

      const anchor = root.getBoundingClientRect();
      const above = anchor.top - top;
      const below = bottom - anchor.bottom;
      const preferred = placement === "up" ? above : below;
      const other = placement === "up" ? below : above;
      menu.style.removeProperty("--dd-available-height");
      // The menu sits a gap away from its trigger; it fits only if that gap
      // and its height both fit in the preferred space.
      const box = menu.getBoundingClientRect();
      const gap = Math.max(0, menu.hasAttribute("data-up") ? anchor.top - box.bottom : box.top - anchor.bottom);
      const flip = preferred - gap < menu.offsetHeight && other > preferred;
      menu.toggleAttribute("data-up", flip ? placement === "down" : placement === "up");
      menu.style.setProperty("--dd-available-height", `${Math.max(0, flip ? other : preferred)}px`);
    };

    positionMenu();
    (searchRef.current ?? listRef.current)?.focus({ preventScroll: true });
    window.addEventListener("resize", positionMenu);
    return () => window.removeEventListener("resize", positionMenu);
  }, [open, placement]);

  useLayoutEffect(() => {
    const menu = menuRef.current;
    const option = listRef.current?.querySelector<HTMLElement>(`[data-index="${active}"]`);
    if (!open || !menu || !option) return;

    const menuBounds = menu.getBoundingClientRect();
    const menuTop = menuBounds.top + menu.clientTop;
    const visibleTop = searchRef.current?.parentElement?.getBoundingClientRect().bottom ?? menuTop;
    const visibleBottom = menuTop + menu.clientHeight;
    const bounds = option.getBoundingClientRect();
    // Keep the active row visible without scrolling any enclosing pane.
    if (bounds.top < visibleTop) menu.scrollTop += bounds.top - visibleTop;
    else if (bounds.bottom > visibleBottom) menu.scrollTop += bounds.bottom - visibleBottom;
  }, [active, open, search]);

  const move = (delta: number) => {
    if (visibleOptions.length === 0) return;
    let next = active;
    for (let i = 0; i < visibleOptions.length; i += 1) {
      next = (next + delta + visibleOptions.length) % visibleOptions.length;
      if (!visibleOptions[next].disabled) break;
    }
    setActive(next);
  };

  const choose = (index: number) => {
    const option = visibleOptions[index];
    if (!option || option.disabled) return;
    if (option.value !== value) onChange(option.value);
    close(true);
  };

  const onListKeyDown = (event: React.KeyboardEvent) => {
    if (event.target === searchRef.current && [" ", "Home", "End"].includes(event.key)) return;
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
        setActive(visibleOptions.length - 1);
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
        <div
          ref={menuRef}
          className={[
            "ovf-menu dd-menu",
            align === "end" ? "end" : "",
          ]
            .filter(Boolean)
            .join(" ")}
          onKeyDown={onListKeyDown}
        >
          {searchPlaceholder && (
            <div className="sticky top-0 z-10 bg-bg-2 p-1">
              <input
                ref={searchRef}
                role="combobox"
                aria-label={searchPlaceholder}
                aria-expanded="true"
                aria-autocomplete="list"
                aria-controls={listId}
                aria-activedescendant={visibleOptions.length ? `${listId}-${active}` : undefined}
                className="ctl ctl-field ctl-outline w-full"
                placeholder={searchPlaceholder}
                value={search}
                onChange={(event) => {
                  setSearch(event.target.value);
                  setActive(0);
                }}
              />
            </div>
          )}
          <ul
            ref={listRef}
            id={listId}
            role="listbox"
            aria-label={ariaLabel}
            aria-activedescendant={visibleOptions.length ? `${listId}-${active}` : undefined}
            tabIndex={-1}
            className="m-0 list-none p-0 outline-none"
          >
            {visibleOptions.map((option, index) => (
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
          {visibleOptions.length === 0 && searchPlaceholder && (
            <p role="status" className="px-2 py-1 text-secondary text-fg-soft">No matching fonts</p>
          )}
        </div>
      )}
    </span>
  );
}

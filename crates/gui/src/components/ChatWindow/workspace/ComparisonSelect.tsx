import {
  useEffect,
  useLayoutEffect,
  useId,
  useRef,
  useState,
  type CSSProperties,
  type RefObject,
} from "react";
import { createPortal } from "react-dom";
import type { SelectOption } from "../../atoms/Select";

/** A themed comparison picker; native option menus cannot share the webview theme. */
export function ComparisonSelect({
  label,
  value,
  options,
  onChange,
  buttonRef,
  shortcut,
}: {
  label: string;
  value: string;
  options: readonly SelectOption[];
  onChange(value: string): void;
  buttonRef?: RefObject<HTMLButtonElement | null>;
  shortcut?: string;
}) {
  const id = useId();
  const localTrigger = useRef<HTMLButtonElement>(null);
  const trigger = buttonRef ?? localTrigger;
  const menu = useRef<HTMLDivElement>(null);
  const [query, setQuery] = useState("");

  const [open, setOpen] = useState(false);
  const [activeValue, setActiveValue] = useState(value);
  const [position, setPosition] = useState<CSSProperties>({});

  const selected = options.find((option) => option.value === value);
  const visible = options.filter((option) =>
    option.label.toLocaleLowerCase().includes(query.toLocaleLowerCase())
  );
  const preferred = visible.findIndex(
    (option) => option.value === activeValue && !option.disabled
  );
  const active =
    preferred >= 0
      ? preferred
      : visible.findIndex((option) => !option.disabled);

  useLayoutEffect(() => {
    if (!open) return;

    const place = () => {
      const rect = trigger.current?.getBoundingClientRect();
      if (!rect) return;

      const below = window.innerHeight - rect.bottom - 12;
      const above = rect.top - 12;
      const down = below >= 180 || below >= above;
      const width = Math.min(Math.max(rect.width, 240), window.innerWidth - 16);

      setPosition({
        position: "fixed",
        width,
        left: Math.max(8, Math.min(rect.left, window.innerWidth - width - 8)),
        top: down ? rect.bottom + 4 : undefined,
        bottom: down ? undefined : window.innerHeight - rect.top + 4,
        maxHeight: Math.max(40, Math.min(280, down ? below : above)),
      });
    };

    const outside = (event: PointerEvent) => {
      if (
        event.target instanceof Node &&
        !trigger.current?.contains(event.target) &&
        !menu.current?.contains(event.target)
      )
        setOpen(false);
    };

    place();

    document.addEventListener("pointerdown", outside);
    window.addEventListener("resize", place);
    window.addEventListener("scroll", place, true);

    return () => {
      document.removeEventListener("pointerdown", outside);
      window.removeEventListener("resize", place);
      window.removeEventListener("scroll", place, true);
    };
  }, [open, trigger]);

  useEffect(() => {
    if (open)
      menu.current
        ?.querySelector<HTMLElement>("[data-focused=true]")
        ?.scrollIntoView?.({ block: "nearest" });
  }, [open, active]);

  const show = () => {
    trigger.current?.focus();
    setActiveValue(value);
    setQuery("");
    setOpen(true);
  };

  const choose = (index: number) => {
    const option = visible[index];
    if (!option || option.disabled) return;

    onChange(option.value);
    setOpen(false);
  };

  const move = (from: number, direction: number) => {
    for (
      let i = from + direction;
      i >= 0 && i < visible.length;
      i += direction
    ) {
      if (!visible[i].disabled) {
        setActiveValue(visible[i].value);
        break;
      }
    }
  };

  return (
    <>
      <button
        ref={trigger}
        type="button"
        role="combobox"
        aria-label={label}
        value={value}
        aria-expanded={open}
        aria-haspopup="listbox"
        aria-controls={open ? id : undefined}
        aria-keyshortcuts={shortcut?.toUpperCase()}
        title={shortcut ? `${label} (${shortcut})` : label}
        data-owns-escape={open ? "" : undefined}
        aria-activedescendant={
          open && active >= 0 ? `${id}-${active}` : undefined
        }
        className="comparison-select"
        onClick={() => (open ? setOpen(false) : show())}
        onBlur={() => setOpen(false)}
        onKeyDown={(event) => {
          if (
            event.nativeEvent.isComposing ||
            event.metaKey ||
            event.ctrlKey ||
            event.altKey
          )
            return;
          if (event.key === "Escape") {
            if (open) {
              setOpen(false);
              event.preventDefault();
              event.stopPropagation();
            }
            return;
          }

          if (event.key === "Tab") {
            setOpen(false);
            return;
          }

          if (["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) {
            event.preventDefault();

            if (!open) {
              show();
              return;
            }

            if (event.key === "Home") move(-1, 1);
            else if (event.key === "End") move(visible.length, -1);
            else move(active, event.key === "ArrowDown" ? 1 : -1);
          } else if (
            event.key === "Enter" ||
            (event.key === " " && (!open || !query))
          ) {
            event.preventDefault();

            if (open) choose(active);
            else show();
          } else if (
            event.key.length === 1 ||
            (open && event.key === "Backspace")
          ) {
            event.preventDefault();
            if (!open) show();
            setQuery(
              event.key === "Backspace"
                ? query.slice(0, -1)
                : (open ? query : "") + event.key
            );
            setActiveValue("");
          }
        }}
      >
        <span className="comparison-select-label">
          {selected?.label ?? "Selection unavailable"}
        </span>
        <span className="comparison-select-caret" aria-hidden="true" />
      </button>
      {open &&
        createPortal(
          <div ref={menu} className="comparison-options" style={position}>
            <div className="comparison-filter" role="status">
              {query ? `Filter: ${query}` : "Type to filter"}
            </div>
            {visible.length === 0 && (
              <p className="comparison-filter" role="status">
                No matching options
              </p>
            )}
            <div id={id} role="listbox" aria-label={label}>
              {visible.map((option, index) => (
                <div
                  key={option.value}
                  id={`${id}-${index}`}
                  role="option"
                  aria-selected={option.value === value}
                  aria-disabled={option.disabled || undefined}
                  data-value={option.value}
                  data-focused={active === index}
                  className="comparison-option"
                  onPointerMove={() =>
                    !option.disabled && setActiveValue(option.value)
                  }
                  onPointerDown={(event) => event.preventDefault()}
                  onClick={() => choose(index)}
                >
                  <span className="comparison-option-check" aria-hidden="true">
                    {option.value === value ? "✓" : ""}
                  </span>
                  <span>{option.label}</span>
                </div>
              ))}
            </div>
          </div>,
          document.body
        )}
    </>
  );
}

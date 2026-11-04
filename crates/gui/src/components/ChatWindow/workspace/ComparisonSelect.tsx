import {
  useEffect,
  useLayoutEffect,
  useId,
  useRef,
  useState,
  type CSSProperties,
} from "react";
import { createPortal } from "react-dom";
import type { SelectOption } from "../../atoms/Select";

/** A themed comparison picker; native option menus cannot share the webview theme. */
export function ComparisonSelect({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: string;
  options: readonly SelectOption[];
  onChange(value: string): void;
}) {
  const id = useId();
  const trigger = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  const search = useRef({ text: "", at: 0 });

  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const [position, setPosition] = useState<CSSProperties>({});

  const selected = options.findIndex((option) => option.value === value);

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
  }, [open]);

  useEffect(() => {
    if (open)
      menu.current
        ?.querySelector<HTMLElement>("[data-focused=true]")
        ?.scrollIntoView?.({ block: "nearest" });
  }, [open, active]);

  useEffect(() => {
    setActive((index) => Math.min(index, Math.max(0, options.length - 1)));
  }, [options.length]);

  const show = () => {
    trigger.current?.focus();
    setActive(Math.max(0, selected));
    setOpen(true);
    search.current = { text: "", at: 0 };
  };

  const choose = (index: number) => {
    const option = options[index];
    if (!option || option.disabled) return;

    onChange(option.value);
    setOpen(false);
  };

  const move = (from: number, direction: number) => {
    for (
      let i = from + direction;
      i >= 0 && i < options.length;
      i += direction
    ) {
      if (!options[i].disabled) {
        setActive(i);
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
        aria-activedescendant={open ? `${id}-${active}` : undefined}
        className="comparison-select"
        onClick={() => (open ? setOpen(false) : show())}
        onBlur={() => setOpen(false)}
        onKeyDown={(event) => {
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
            else if (event.key === "End") move(options.length, -1);
            else move(active, event.key === "ArrowDown" ? 1 : -1);
          } else if (event.key === "Enter" || event.key === " ") {
            event.preventDefault();

            if (open) choose(active);
            else show();
          } else if (
            event.key.length === 1 &&
            !event.ctrlKey &&
            !event.metaKey &&
            !event.altKey
          ) {
            event.preventDefault();

            if (!open) show();

            const now = Date.now();
            const text =
              (now - search.current.at < 600 ? search.current.text : "") +
              event.key.toLocaleLowerCase();
            search.current = { text, at: now };

            const index = options.findIndex(
              (option) =>
                !option.disabled &&
                option.label.toLocaleLowerCase().startsWith(text)
            );

            if (index >= 0) setActive(index);
          }
        }}
      >
        <span className="comparison-select-label">
          {options[selected]?.label ?? "Selection unavailable"}
        </span>
        <span className="comparison-select-caret" aria-hidden="true" />
      </button>
      {open &&
        createPortal(
          <div
            ref={menu}
            id={id}
            role="listbox"
            aria-label={label}
            className="comparison-options"
            style={position}
          >
            {options.map((option, index) => (
              <div
                key={option.value}
                id={`${id}-${index}`}
                role="option"
                aria-selected={option.value === value}
                aria-disabled={option.disabled || undefined}
                data-value={option.value}
                data-focused={active === index}
                className="comparison-option"
                onPointerMove={() => !option.disabled && setActive(index)}
                onPointerDown={(event) => event.preventDefault()}
                onClick={() => choose(index)}
              >
                <span className="comparison-option-check" aria-hidden="true">
                  {option.value === value ? "✓" : ""}
                </span>
                <span>{option.label}</span>
              </div>
            ))}
          </div>,
          document.body
        )}
    </>
  );
}

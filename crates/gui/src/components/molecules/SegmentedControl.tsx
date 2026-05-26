import { useRef, type ReactNode } from "react";

export interface SegmentedOption<T extends string> {
  value: T;
  label: ReactNode;
}

interface SegmentedControlProps<T extends string> {
  /** The selectable options, rendered left to right. */
  options: ReadonlyArray<SegmentedOption<T>>;
  /** The currently selected value. */
  value: T;
  /** Called with the newly selected value. */
  onChange: (value: T) => void;
  disabled?: boolean;
  /** Accessible label for the group (role="radiogroup"). */
  ariaLabel?: string;
  className?: string;
}

/**
 * A segmented control for mutually-exclusive choices — a row of labeled
 * pills where exactly one is selected. Use this instead of multiple
 * checkboxes when the options represent a single either/or decision.
 *
 * Implements the WAI-ARIA radiogroup pattern: roving tabindex plus
 * arrow/Home/End key navigation.
 */
export function SegmentedControl<T extends string>({
  options,
  value,
  onChange,
  disabled = false,
  ariaLabel,
  className = "",
}: SegmentedControlProps<T>) {
  const refs = useRef<Array<HTMLButtonElement | null>>([]);
  const selectedIndex = options.findIndex((o) => o.value === value);

  const select = (index: number) => {
    const option = options[index];
    if (!option) return;
    onChange(option.value);
    refs.current[index]?.focus();
  };

  const handleKeyDown = (event: React.KeyboardEvent) => {
    if (disabled) return;
    const base = selectedIndex < 0 ? 0 : selectedIndex;
    switch (event.key) {
      case "ArrowRight":
      case "ArrowDown":
        event.preventDefault();
        select((base + 1) % options.length);
        break;
      case "ArrowLeft":
      case "ArrowUp":
        event.preventDefault();
        select((base - 1 + options.length) % options.length);
        break;
      case "Home":
        event.preventDefault();
        select(0);
        break;
      case "End":
        event.preventDefault();
        select(options.length - 1);
        break;
      default:
        break;
    }
  };

  return (
    <div
      role="radiogroup"
      aria-label={ariaLabel}
      onKeyDown={handleKeyDown}
      className={`inline-flex overflow-hidden rounded-[var(--radius-md)] border border-[var(--color-line-strong)] ${
        disabled ? "opacity-50" : ""
      } ${className}`}
    >
      {options.map((option, index) => {
        const selected = option.value === value;
        const tabbable = selected || (selectedIndex < 0 && index === 0);
        return (
          <button
            key={option.value}
            ref={(el) => {
              refs.current[index] = el;
            }}
            type="button"
            role="radio"
            aria-checked={selected}
            tabIndex={tabbable ? 0 : -1}
            disabled={disabled}
            onClick={() => !disabled && onChange(option.value)}
            className={`px-3 py-1 text-xs font-medium transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[var(--color-accent)] ${
              index > 0 ? "border-l border-[var(--color-line-strong)]" : ""
            } ${
              selected
                ? `bg-[var(--color-accent-wash)] text-[var(--color-accent)]${
                    disabled
                      ? ""
                      : " hover:bg-[color-mix(in_oklch,var(--color-accent)_22%,transparent)]"
                  }`
                : `bg-[var(--color-bg-2)] text-[var(--color-fg-mute)]${
                    disabled
                      ? ""
                      : " hover:bg-[var(--color-bg-3)] hover:text-[var(--color-fg-soft)]"
                  }`
            } ${disabled ? "cursor-not-allowed" : "cursor-pointer"}`}
          >
            {option.label}
          </button>
        );
      })}
    </div>
  );
}

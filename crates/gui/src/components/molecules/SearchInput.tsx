import {
  forwardRef,
  useEffect,
  useRef,
  useState,
  type InputHTMLAttributes,
} from "react";

interface SearchInputProps
  extends Omit<InputHTMLAttributes<HTMLInputElement>, "type" | "onChange"> {
  value?: string;
  defaultValue?: string;
  /** Fired with the current input value, debounced by `debounceMs`. */
  onSearch?: (value: string) => void;
  /** Synchronous onChange — fires on every keystroke before debouncing. */
  onChange?: (value: string) => void;
  debounceMs?: number;
  /** Optional keyboard-hint badge rendered on the right (e.g. "/"). */
  hint?: string;
}

const wrapperClasses =
  "relative inline-flex w-full items-center";

const inputClasses =
  "w-full h-[34px] pl-8 pr-8 bg-[var(--color-bg-1)] " +
  "border border-[var(--color-line-strong)] rounded-[var(--radius-md)] " +
  "font-sans text-xs text-[var(--color-fg)] placeholder:text-[var(--color-fg-faint)] " +
  "transition-[border-color,box-shadow] duration-[var(--t-fast)] ease-[var(--ease-default)] " +
  "focus:outline-none focus:border-[var(--color-accent)] focus:shadow-[0_0_0_3px_var(--color-accent-wash)]";

/**
 * Filter/search input. Debounces calls to onSearch (default 150ms) so list
 * filtering stays responsive without thrashing.
 */
export const SearchInput = forwardRef<HTMLInputElement, SearchInputProps>(
  function SearchInput(
    {
      value: controlled,
      defaultValue = "",
      onSearch,
      onChange,
      debounceMs = 150,
      placeholder = "Search…",
      hint,
      className,
      ...rest
    },
    ref,
  ) {
    const isControlled = controlled !== undefined;
    const [internal, setInternal] = useState(defaultValue);
    const value = isControlled ? (controlled as string) : internal;
    const debounceTimer = useRef<ReturnType<typeof setTimeout> | undefined>(
      undefined,
    );

    useEffect(
      () => () => {
        if (debounceTimer.current) clearTimeout(debounceTimer.current);
      },
      [],
    );

    function commit(next: string) {
      onChange?.(next);
      if (!onSearch) return;
      if (debounceTimer.current) clearTimeout(debounceTimer.current);
      debounceTimer.current = setTimeout(() => onSearch(next), debounceMs);
    }

    function handleClear() {
      if (!isControlled) setInternal("");
      commit("");
    }

    function handleKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
      if (e.key === "Escape" && value) {
        e.preventDefault();
        e.stopPropagation();
        handleClear();
      }
    }

    return (
      <span className={[wrapperClasses, className].filter(Boolean).join(" ")}>
        <svg
          aria-hidden
          className="pointer-events-none absolute left-2.5 h-3.5 w-3.5 text-[var(--color-fg-mute)]"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth={2}
        >
          <circle cx="11" cy="11" r="6" />
          <path d="m20 20-3-3" strokeLinecap="round" />
        </svg>
        <input
          ref={ref}
          type="search"
          value={value}
          placeholder={placeholder}
          className={inputClasses}
          onChange={(e) => {
            const v = e.target.value;
            if (!isControlled) setInternal(v);
            commit(v);
          }}
          onKeyDown={handleKeyDown}
          {...rest}
        />
        {value ? (
          <button
            type="button"
            onClick={handleClear}
            aria-label="Clear search"
            className="absolute right-2 inline-flex h-4 w-4 items-center justify-center rounded-full text-[var(--color-fg-mute)] hover:text-[var(--color-fg)]"
          >
            ×
          </button>
        ) : (
          hint && (
            <kbd
              aria-hidden
              className="pointer-events-none absolute right-2 rounded-[var(--radius-xs)] border border-[var(--color-line-strong)] bg-[var(--color-bg-2)] px-1.5 py-px font-mono text-2xs text-[var(--color-fg-mute)]"
            >
              {hint}
            </kbd>
          )
        )}
      </span>
    );
  },
);

import { forwardRef, type SelectHTMLAttributes } from "react";

export interface SelectOption {
  value: string;
  label: string;
  disabled?: boolean;
}

export interface SelectOptionGroup {
  label: string;
  options: SelectOption[];
}

interface SelectProps
  extends Omit<SelectHTMLAttributes<HTMLSelectElement>, "children"> {
  options: ReadonlyArray<SelectOption | SelectOptionGroup>;
  placeholder?: string;
  invalid?: boolean;
}

const classes =
  "w-full h-[34px] pl-3 pr-8 appearance-none bg-[var(--color-bg-1)] " +
  "border border-[var(--color-line-strong)] rounded-[var(--radius-md)] " +
  "font-sans text-sm text-[var(--color-fg)] " +
  "transition-[border-color,box-shadow] duration-[var(--t-fast)] ease-[var(--ease-default)] " +
  "focus:outline-none focus:border-[var(--color-accent)] focus:shadow-[0_0_0_3px_var(--color-accent-wash)] " +
  "disabled:cursor-not-allowed disabled:opacity-50";

const wrapperClasses =
  "relative inline-flex w-full items-center after:pointer-events-none " +
  "after:absolute after:right-3 after:top-1/2 after:-mt-1 after:h-2 after:w-2 " +
  "after:border-r after:border-b after:border-[var(--color-fg-mute)] after:rotate-45";

function isGroup(
  o: SelectOption | SelectOptionGroup,
): o is SelectOptionGroup {
  return (o as SelectOptionGroup).options !== undefined;
}

/**
 * Single-option dropdown. Wraps native <select> so platform-native keyboard
 * support (↑/↓, type-ahead) is preserved.
 */
export const Select = forwardRef<HTMLSelectElement, SelectProps>(function Select(
  { options, placeholder, invalid, className, ...rest },
  ref,
) {
  const selectClasses = [
    classes,
    invalid && "border-[var(--color-err)]",
    className,
  ]
    .filter(Boolean)
    .join(" ");

  return (
    <span className={wrapperClasses}>
      <select
        ref={ref}
        className={selectClasses}
        aria-invalid={invalid || undefined}
        {...rest}
      >
        {placeholder && (
          <option value="" disabled hidden>
            {placeholder}
          </option>
        )}
        {options.map((opt, idx) =>
          isGroup(opt) ? (
            <optgroup key={`group-${idx}`} label={opt.label}>
              {opt.options.map((o) => (
                <option key={o.value} value={o.value} disabled={o.disabled}>
                  {o.label}
                </option>
              ))}
            </optgroup>
          ) : (
            <option key={opt.value} value={opt.value} disabled={opt.disabled}>
              {opt.label}
            </option>
          ),
        )}
      </select>
    </span>
  );
});

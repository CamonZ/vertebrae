import type { ChangeEvent } from "react";
import { Dropdown, type DropdownOption } from "../molecules/Dropdown";

export interface SelectOption {
  value: string;
  label: string;
  disabled?: boolean;
  /** CSS colour shown as a dot before the label. */
  swatch?: string;
}

export interface SelectOptionGroup {
  label: string;
  options: SelectOption[];
}

interface SelectProps {
  options: ReadonlyArray<SelectOption | SelectOptionGroup>;
  value?: string;
  /** Receives a change event whose `target.value` is the chosen value. */
  onChange?: (event: ChangeEvent<HTMLSelectElement>) => void;
  placeholder?: string;
  invalid?: boolean;
  disabled?: boolean;
  id?: string;
  className?: string;
  "aria-label"?: string;
  "data-testid"?: string;
  "aria-describedby"?: string;
  "aria-invalid"?: boolean | "true" | "false";
  /**
   * `field` fills a form row (Settings, editors, dialogs); `chip` sizes to its
   * label for toolbars and the composer.
   */
  size?: "field" | "chip";
  /** `outline` shows a hairline edge; `quiet` shows it only on hover. */
  variant?: "outline" | "quiet";
  /** Open the menu above the trigger. */
  placement?: "down" | "up";
  /** Extra data-* attributes land on the trigger. */
  [dataAttribute: `data-${string}`]: string | undefined;
}

function isGroup(o: SelectOption | SelectOptionGroup): o is SelectOptionGroup {
  return (o as SelectOptionGroup).options !== undefined;
}

/**
 * The single-choice picker used everywhere. It renders the app's own
 * `Dropdown` (the shared menu surface), so no picker falls back to the
 * platform popup. Keeps the select-style API: `value`, `options` and an
 * `onChange` whose `event.target.value` is the chosen value.
 */
export function Select({
  options,
  value = "",
  onChange,
  placeholder,
  invalid,
  disabled,
  id,
  className,
  "aria-label": ariaLabel,
  "data-testid": testId,
  "aria-describedby": ariaDescribedBy,
  "aria-invalid": ariaInvalid,
  size = "field",
  variant = "outline",
  placement,
  ...dataAttributes
}: SelectProps) {
  const flat: DropdownOption[] = options.flatMap((option) =>
    isGroup(option) ? option.options : [option]
  );
  const hasValue = flat.some((option) => option.value === value);
  const shown =
    placeholder && !hasValue
      ? [{ value, label: placeholder, disabled: true }, ...flat]
      : flat;

  return (
    <Dropdown
      id={id}
      options={shown}
      value={value}
      aria-label={ariaLabel}
      data-testid={testId}
      size={size === "field" ? "field" : "chip"}
      variant={variant}
      placement={placement}
      disabled={disabled}
      invalid={invalid || ariaInvalid === true || ariaInvalid === "true"}
      aria-describedby={ariaDescribedBy}
      className={className}
      triggerAttributes={dataAttributes}
      onChange={(next) => {
        const target = { value: next } as HTMLSelectElement;
        onChange?.({
          target,
          currentTarget: target,
        } as ChangeEvent<HTMLSelectElement>);
      }}
    />
  );
}

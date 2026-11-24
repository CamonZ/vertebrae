import { forwardRef, type InputHTMLAttributes } from "react";
import { Input } from "./Input";

interface NumberInputProps
  extends Omit<
    InputHTMLAttributes<HTMLInputElement>,
    "type" | "value" | "onChange" | "min" | "max" | "step" | "size"
  > {
  /** Current text; kept as a string so partial entries can be edited. */
  value: string;
  /** Called with the new text on typing and on each stepper press. */
  onValueChange: (text: string) => void;
  min?: number;
  max?: number;
  step?: number;
  invalid?: boolean;
  /** Accept fractional entries (the steppers still move by `step`). */
  allowDecimals?: boolean;
  /** `field` fills a form row; `compact` is the narrow inline size. */
  size?: "field" | "compact";
}

const STEP_BUTTON =
  "ctl ctl-quiet h-6 w-6 justify-center p-0 text-[var(--color-fg-soft)]";

/**
 * Numeric entry with the shared input edge and quiet −/+ steppers in place of
 * the platform spinner, so numbers look like every other control.
 */
export const NumberInput = forwardRef<HTMLInputElement, NumberInputProps>(
  function NumberInput(
    {
      value,
      onValueChange,
      min,
      max,
      step = 1,
      invalid,
      allowDecimals = false,
      size = "field",
      disabled,
      className,
      "aria-label": ariaLabel,
      ...rest
    },
    ref
  ) {
    const stepBy = (direction: 1 | -1) => {
      const current = Number(value);
      const base = value.trim() === "" || Number.isNaN(current)
        ? (min ?? 0)
        : current + direction * step;
      let next = base;
      if (min !== undefined) next = Math.max(min, next);
      if (max !== undefined) next = Math.min(max, next);
      onValueChange(String(next));
    };
    const current = Number(value);
    const atMin = min !== undefined && value.trim() !== "" && current <= min;
    const atMax = max !== undefined && value.trim() !== "" && current >= max;
    const label = ariaLabel ?? "value";

    return (
      <span
        className={[
          "relative inline-flex items-center",
          size === "field" ? "w-full" : "w-24",
        ].join(" ")}
      >
        <Input
          ref={ref}
          type="number"
          inputMode={allowDecimals ? "decimal" : "numeric"}
          min={min}
          max={max}
          step={allowDecimals ? "any" : step}
          value={value}
          invalid={invalid}
          disabled={disabled}
          aria-label={ariaLabel}
          onChange={(event) => onValueChange(event.target.value)}
          className={[
            "no-spin pr-[60px] tabular-nums",
            size === "compact" && "h-7 text-secondary",
            className,
          ]
            .filter(Boolean)
            .join(" ")}
          {...rest}
        />
        <span className="absolute right-1 inline-flex items-center gap-0.5">
          <button
            type="button"
            tabIndex={-1}
            className={STEP_BUTTON}
            aria-label={`Decrease ${label}`}
            disabled={disabled || atMin}
            onClick={() => stepBy(-1)}
          >
            <svg aria-hidden="true" viewBox="0 0 24 24" className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round">
              <path d="M6 12h12" />
            </svg>
          </button>
          <button
            type="button"
            tabIndex={-1}
            className={STEP_BUTTON}
            aria-label={`Increase ${label}`}
            disabled={disabled || atMax}
            onClick={() => stepBy(1)}
          >
            <svg aria-hidden="true" viewBox="0 0 24 24" className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round">
              <path d="M12 6v12M6 12h12" />
            </svg>
          </button>
        </span>
      </span>
    );
  }
);

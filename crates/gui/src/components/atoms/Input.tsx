import {
  forwardRef,
  type InputHTMLAttributes,
  type TextareaHTMLAttributes,
} from "react";

const baseClasses =
  "w-full bg-[var(--color-bg-1)] border border-[var(--color-line-strong)] " +
  "font-sans text-[var(--color-fg)] placeholder:text-[var(--color-fg-faint)] " +
  "rounded-[var(--radius-md)] transition-[border-color,box-shadow] duration-[var(--t-fast)] ease-[var(--ease-default)] " +
  "focus:outline-none focus:border-[var(--color-accent)] focus:shadow-[0_0_0_3px_var(--color-accent-wash)] " +
  "disabled:cursor-not-allowed disabled:opacity-50";

const invalidClasses =
  "border-[var(--color-err)] focus:border-[var(--color-err)] focus:shadow-[0_0_0_3px_var(--color-err-wash)]";

const monoClasses = "font-mono text-sm";

interface SharedProps {
  invalid?: boolean;
  mono?: boolean;
}

interface InputProps
  extends InputHTMLAttributes<HTMLInputElement>,
    SharedProps {}

/** Single-line text entry. */
export const Input = forwardRef<HTMLInputElement, InputProps>(function Input(
  { invalid, mono, className, ...rest },
  ref,
) {
  const classes = [
    baseClasses,
    "h-[34px] px-3 text-sm",
    invalid && invalidClasses,
    mono && monoClasses,
    className,
  ]
    .filter(Boolean)
    .join(" ");

  return (
    <input
      ref={ref}
      type={rest.type ?? "text"}
      aria-invalid={invalid || undefined}
      className={classes}
      {...rest}
    />
  );
});

interface TextareaProps
  extends TextareaHTMLAttributes<HTMLTextAreaElement>,
    SharedProps {
  /** Approximate max rows before scrolling kicks in. */
  maxRows?: number;
}

/** Multi-line text entry. Auto-sizes by browser default; cap via maxRows. */
export const Textarea = forwardRef<HTMLTextAreaElement, TextareaProps>(
  function Textarea({ invalid, mono, maxRows, className, style, ...rest }, ref) {
    const classes = [
      baseClasses,
      "px-3 py-2 text-sm leading-relaxed resize-y",
      invalid && invalidClasses,
      mono && monoClasses,
      className,
    ]
      .filter(Boolean)
      .join(" ");

    const computedStyle = maxRows
      ? { ...style, maxHeight: `${maxRows * 1.5 + 1}em` }
      : style;

    return (
      <textarea
        ref={ref}
        aria-invalid={invalid || undefined}
        className={classes}
        style={computedStyle}
        {...rest}
      />
    );
  },
);

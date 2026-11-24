import {
  forwardRef,
  type InputHTMLAttributes,
  type TextareaHTMLAttributes,
} from "react";

// Same edge, radius and focus halo as the `.ctl` controls (selects, chips).
const baseClasses =
  "w-full bg-transparent border border-[var(--ctl-line)] " +
  "font-sans text-[var(--color-fg)] placeholder:text-[var(--color-fg-faint)] " +
  "rounded-[var(--ctl-radius)] transition-[border-color,box-shadow,background-color] duration-[var(--t-fast)] ease-[var(--ease-default)] " +
  "hover:border-[var(--ctl-line-hover)] " +
  "disabled:cursor-not-allowed disabled:opacity-50";

const invalidClasses =
  "border-[var(--color-err)]";

const monoClasses = "font-mono text-content";

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
    "h-8 px-2.5 text-content",
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
      "px-3 py-2 text-content leading-relaxed resize-y",
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

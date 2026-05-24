import {
  forwardRef,
  useState,
  type ButtonHTMLAttributes,
  type ReactNode,
} from "react";
import { Spinner } from "../Spinner";

export type ButtonVariant = "primary" | "secondary" | "ghost" | "danger";
export type ButtonSize = "sm" | "md" | "lg";

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: ButtonSize;
  loading?: boolean;
  fullWidth?: boolean;
  iconLeft?: ReactNode;
  iconRight?: ReactNode;
  /** When variant="danger", show an inline confirm step before firing onClick. */
  confirm?: boolean;
  confirmLabel?: string;
}

const baseClasses =
  "inline-flex items-center justify-center gap-2 font-sans font-medium border whitespace-nowrap select-none rounded-[var(--radius-md)] " +
  "transition-[background-color,border-color,color,box-shadow] duration-[var(--t-fast)] ease-[var(--ease-default)] " +
  "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-accent)] focus-visible:ring-offset-2 focus-visible:ring-offset-[var(--color-bg)] " +
  "disabled:cursor-not-allowed disabled:opacity-40";

const sizeClasses: Record<ButtonSize, string> = {
  sm: "h-[26px] px-3 text-xs",
  md: "h-8 px-4 text-sm",
  lg: "h-10 px-5 text-sm",
};

const variantClasses: Record<ButtonVariant, string> = {
  primary:
    "bg-[var(--color-accent)] text-[var(--color-bg)] border-[var(--color-accent)] font-semibold hover:bg-[var(--color-accent-deep)] hover:border-[var(--color-accent-deep)] hover:shadow-[0_0_16px_var(--color-accent-glow)]",
  secondary:
    "bg-transparent text-[var(--color-fg)] border-[var(--color-line-strong)] hover:border-[var(--color-accent)] hover:text-[var(--color-accent)]",
  ghost:
    "bg-transparent text-[var(--color-fg-soft)] border-transparent hover:bg-[var(--color-bg-1)] hover:text-[var(--color-accent)]",
  danger:
    "bg-[var(--color-err)] text-[var(--color-bg)] border-[var(--color-err)] font-semibold hover:bg-transparent hover:text-[var(--color-err)]",
};

/**
 * Primary interactive control. Variants encode emphasis; danger optionally
 * requires a second click to confirm destructive intent.
 */
export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  {
    variant = "secondary",
    size = "md",
    loading = false,
    fullWidth,
    iconLeft,
    iconRight,
    confirm,
    confirmLabel = "Sure?",
    className,
    children,
    onClick,
    disabled,
    type = "button",
    ...rest
  },
  ref,
) {
  const [armed, setArmed] = useState(false);

  const classes = [
    baseClasses,
    sizeClasses[size],
    variantClasses[variant],
    fullWidth && "w-full",
    className,
  ]
    .filter(Boolean)
    .join(" ");

  function handleClick(event: React.MouseEvent<HTMLButtonElement>) {
    if (loading || disabled) return;
    if (variant === "danger" && confirm && !armed) {
      event.preventDefault();
      setArmed(true);
      return;
    }
    setArmed(false);
    onClick?.(event);
  }

  function handleBlur() {
    if (armed) setArmed(false);
  }

  return (
    <button
      ref={ref}
      type={type}
      className={classes}
      onClick={handleClick}
      onBlur={handleBlur}
      disabled={disabled || loading}
      aria-busy={loading || undefined}
      {...rest}
    >
      {loading ? <Spinner className="h-3.5 w-3.5" /> : iconLeft}
      <span>{armed ? confirmLabel : children}</span>
      {!loading && iconRight}
    </button>
  );
});

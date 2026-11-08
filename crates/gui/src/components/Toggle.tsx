interface ToggleProps {
  checked: boolean;
  onChange: (checked: boolean) => void;
  label: string;
  /** Color when toggle is on. Defaults to neutral */
  activeColor?:
    | "neutral"
    | "primary"
    | "warning"
    | "success"
    | "error"
    | "info";
  disabled?: boolean;
}

/**
 * Reusable toggle/switch component with consistent styling and accessibility.
 */
export function Toggle({
  checked,
  onChange,
  label,
  activeColor = "neutral",
  disabled = false,
}: ToggleProps) {
  return (
    <button
      type="button"
      onClick={() => !disabled && onChange(!checked)}
      className="app-toggle"
      data-active-color={activeColor}
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
    >
      <span aria-hidden="true" />
    </button>
  );
}

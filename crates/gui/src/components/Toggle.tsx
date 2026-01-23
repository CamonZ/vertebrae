interface ToggleProps {
  checked: boolean;
  onChange: (checked: boolean) => void;
  label: string;
  /** Color when toggle is on. Defaults to "primary" */
  activeColor?: "primary" | "warning" | "success" | "error" | "info";
  disabled?: boolean;
}

const colorClasses = {
  primary: "bg-primary",
  warning: "bg-warning",
  success: "bg-success",
  error: "bg-error",
  info: "bg-info",
};

/**
 * Reusable toggle/switch component with consistent styling and accessibility.
 */
export function Toggle({
  checked,
  onChange,
  label,
  activeColor = "primary",
  disabled = false,
}: ToggleProps) {
  return (
    <button
      type="button"
      onClick={() => !disabled && onChange(!checked)}
      className={`relative inline-flex h-6 w-11 flex-shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors duration-200 ease-in-out focus:outline-none focus:ring-2 focus:ring-primary focus:ring-offset-2 focus:ring-offset-bg-primary disabled:cursor-not-allowed disabled:opacity-50 ${
        checked ? colorClasses[activeColor] : "bg-bg-tertiary"
      }`}
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
    >
      <span
        className={`pointer-events-none inline-block h-5 w-5 transform rounded-full bg-white shadow ring-0 transition duration-200 ease-in-out ${
          checked ? "translate-x-5" : "translate-x-0"
        }`}
      />
    </button>
  );
}

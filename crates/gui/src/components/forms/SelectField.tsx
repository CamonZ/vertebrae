import {
  type SelectHTMLAttributes,
  forwardRef,
} from "react";
import { FormField } from "./FormField";

export interface SelectOption {
  /**
   * Display text for the option
   */
  label: string;
  /**
   * Value that will be returned when selected
   */
  value: string;
  /**
   * Whether the option is disabled
   */
  disabled?: boolean;
  /**
   * Group name for optgroup organization
   */
  group?: string;
}

export interface SelectFieldProps extends Omit<SelectHTMLAttributes<HTMLSelectElement>, "onChange" | "size"> {
  /**
   * The field label text
   */
  label: string;
  /**
   * Optional error message to display below the input
   */
  error?: string;
  /**
   * Whether the field is required (shows asterisk)
   */
  required?: boolean;
  /**
   * Optional help text to display below the label
   */
  helpText?: string;
  /**
   * Array of options to display
   */
  options: SelectOption[];
  /**
   * Current selected value
   */
  value?: string;
  /**
   * Called when the selection changes
   */
  onChange: (value: string) => void;
  /**
   * Placeholder text to show when no option is selected
   */
  placeholder?: string;
  /**
   * Whether to show a placeholder option
   */
  showPlaceholder?: boolean;
  /**
   * Custom HTML id for the select (for label association)
   * Auto-generated if not provided
   */
  id?: string;
  /**
   * Whether the field is disabled
   */
  disabled?: boolean;
  /**
   * Whether to show the arrow icon
   */
  showArrow?: boolean;
  /**
   * Whether the field has search functionality (for large option lists)
   */
  searchable?: boolean;
  /**
   * Size of the select field
   */
  size?: "sm" | "md" | "lg";
}

/**
 * SelectField component with FormField wrapper for dropdown selection.
 *
 * Provides:
 * - Dropdown select with consistent styling
 * - Label, error, help text via FormField wrapper
 * - Option grouping support
 * - Placeholder option
 * - Disabled state for options and field
 * - Size variants
 * - Search support (experimental)
 *
 * @example
 * ```tsx
 * <SelectField
 *   label="Priority"
 *   value={priority}
 *   onChange={setPriority}
 *   options={[
 *     { label: "Low", value: "low" },
 *     { label: "Medium", value: "medium" },
 *     { label: "High", value: "high" }
 *   ]}
 *   placeholder="Select priority"
 *   required
 * />
 * ```
 */
export const SelectField = forwardRef<HTMLSelectElement, SelectFieldProps>(
  (
    {
      label,
      error,
      required = false,
      helpText,
      options,
      value,
      onChange,
      placeholder = "Select an option",
      showPlaceholder = true,
      id: propId,
      disabled = false,
      showArrow = true,
      // searchable = false,
      size = "md",
      className = "",
      ...props
    },
    ref
  ) => {
    // Generate unique ID if not provided
    const inputId = propId || `selectfield-${Math.random().toString(36).slice(2, 9)}`;

    // Handle selection change
    const handleChange = (e: React.ChangeEvent<HTMLSelectElement>) => {
      const selectedValue = e.target.value;
      // Ignore placeholder value
      if (selectedValue === "" && showPlaceholder) {
        onChange("");
        return;
      }
      onChange(selectedValue);
    };

    // Group options by group name
    const groupedOptions = options.reduce((groups, option) => {
      const group = option.group || "ungrouped";
      if (!groups[group]) {
        groups[group] = [];
      }
      groups[group].push(option);
      return groups;
    }, {} as Record<string, SelectOption[]>);

    // Get option groups
    const groups = Object.keys(groupedOptions);

    // Base select classes
    const baseSelectClasses = `
      appearance-none
      w-full
      bg-bg
      border border-border
      text-fg
      rounded-md
      focus:outline-none focus:ring-2 focus:ring-accent focus:ring-offset-2 focus:border-transparent
      disabled:opacity-50 disabled:cursor-not-allowed
      ${disabled ? "bg-bg-1" : ""}
      ${className}
    `;

    // Size classes
    const sizeClasses = {
      sm: "text-sm px-3 py-2",
      md: "text-base px-4 py-2.5",
      lg: "text-lg px-5 py-3",
    };

    // Combined classes
    const selectClasses = `${baseSelectClasses} ${sizeClasses[size]}`.trim();

    // Add opacity-50 class when disabled for better visual feedback
    const finalSelectClasses = disabled ? `${selectClasses} opacity-50` : selectClasses;

    // Get selected option label for display - unused function
    // const getSelectedLabel = () => {
    //   if (!value && showPlaceholder) {
    //     return placeholder;
    //   }
    //   const option = options.find(opt => opt.value === value);
    //   return option?.label || (showPlaceholder ? placeholder : "");
    // };

    return (
      <FormField
        label={label}
        error={error}
        required={required}
        helpText={helpText}
        inputId={inputId}
      >
        <div className="relative">
          <select
            ref={ref}
            id={inputId}
            value={!showPlaceholder && !value ? undefined : value || (showPlaceholder ? "" : undefined)}
            onChange={handleChange}
            disabled={disabled}
            className={finalSelectClasses}
            aria-invalid={error ? "true" : undefined}
            aria-describedby={error ? `${inputId}-error` : undefined}
            {...props}
          >
            {/* Placeholder option */}
            {showPlaceholder && (
              <option value="" disabled>
                {placeholder}
              </option>
            )}

            {/* Render grouped options */}
            {groups.map(groupName => (
              <optgroup key={groupName} label={groupName}>
                {groupedOptions[groupName].map(option => (
                  <option
                    key={option.value}
                    value={option.value}
                    disabled={option.disabled || disabled}
                  >
                    {option.label}
                  </option>
                ))}
              </optgroup>
            ))}
          </select>

          {/* Arrow icon */}
          {showArrow && (
            <div className="absolute inset-y-0 right-0 flex items-center pr-3 pointer-events-none">
              <svg
                className={`h-5 w-5 text-fg-soft ${disabled ? "opacity-50" : ""}`}
                fill="none"
                stroke="currentColor"
                viewBox="0 0 24 24"
                aria-hidden="true"
                data-testid="select-arrow"
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={2}
                  d="M19 9l-7 7-7-7"
                />
              </svg>
            </div>
          )}
        </div>
      </FormField>
    );
  }
);

SelectField.displayName = "SelectField";
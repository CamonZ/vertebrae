import { type HTMLAttributes, forwardRef, useState } from "react";
import { FormField } from "./FormField";

export interface TagFieldProps extends Omit<HTMLAttributes<HTMLDivElement>, "onChange"> {
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
   * Array of current tags
   */
  value: string[];
  /**
   * Called when tags are added or removed
   */
  onChange: (tags: string[]) => void;
  /**
   * Maximum number of allowed tags
   */
  maxTags?: number;
  /**
   * Minimum number of tags required
   */
  minTags?: number;
  /**
   * Minimum length for each tag
   */
  minTagLength?: number;
  /**
   * Maximum length for each tag
   */
  maxTagLength?: number;
  /**
   * Whether to allow duplicate tags
   */
  allowDuplicates?: boolean;
  /**
   * Custom HTML id for the input (for label association)
   * Auto-generated if not provided
   */
  id?: string;
  /**
   * Placeholder text for the tag input
   */
  placeholder?: string;
  /**
   * Text to display when no tags are present
   */
  emptyText?: string;
  /**
   * Custom class names for tag chips
   */
  tagClassName?: string;
  /**
   * Whether to show the tag count
   */
  showCount?: boolean;
}

/**
 * TagField component for managing arrays of tags with validation and duplicate prevention.
 *
 * Provides:
 * - Tag display as removable chips with X button
 * - Text input for adding new tags on Enter key
 * - Validation: duplicate prevention, maxTags limit, min/max length
 * - Visual feedback: duplicate error highlighting, tag count display
 * - Help text for tag requirements
 *
 * @example
 * ```tsx
 * <TagField
 *   label="Tags"
 *   value={tags}
 *   onChange={setTags}
 *   maxTags={10}
 *   minTagLength={2}
 *   maxTagLength={20}
 *   placeholder="Add a tag and press Enter"
 *   emptyText="No tags added yet"
 *   error={tagsError}
 * />
 * ```
 */
export const TagField = forwardRef<HTMLDivElement, TagFieldProps>(
  (
    {
      label,
      error,
      required = false,
      helpText,
      value,
      onChange,
      maxTags,
      minTags,
      minTagLength = 1,
      maxTagLength,
      allowDuplicates = true,
      id: propId,
      placeholder = "Add a tag and press Enter",
      emptyText = "No tags added yet",
      tagClassName,
      showCount = true,
      className = "",
      ...props
    },
    ref
  ) => {
    // Generate unique ID if not provided
    const [generatedId] = useState(() =>
      propId || `tagfield-${Math.random().toString(36).slice(2, 9)}`
    );
    const inputId = propId || generatedId;

    // State for current input value
    const [inputValue, setInputValue] = useState("");

    // Validation state
    const [inputError, setInputError] = useState<string | null>(null);

    // Check if a tag can be added
    const canAddTag = () => {
      const trimmedValue = inputValue.trim();

      // Check for empty input
      if (!trimmedValue) {
        setInputError("Please enter a tag");
        return false;
      }

      // Check length constraints
      if (trimmedValue.length < minTagLength) {
        setInputError(`Tag must be at least ${minTagLength} characters`);
        return false;
      }

      if (maxTagLength && trimmedValue.length > maxTagLength) {
        setInputError(`Tag must be at most ${maxTagLength} characters`);
        return false;
      }

      // Check maxTags limit
      if (maxTags && value.length >= maxTags) {
        setInputError(`Maximum ${maxTags} tags allowed`);
        return false;
      }

      // Check for duplicates
      if (!allowDuplicates && value.includes(trimmedValue)) {
        setInputError("Tag already exists");
        return false;
      }

      return true;
    };

    // Handle adding a tag
    const handleAddTag = () => {
      if (!canAddTag()) {
        return;
      }

      const trimmedValue = inputValue.trim();
      const newTags = [...value, trimmedValue];
      onChange(newTags);
      setInputValue("");
      setInputError(null);
    };

    // Handle removing a tag
    const handleRemoveTag = (index: number) => {
      const newTags = value.filter((_, i) => i !== index);
      onChange(newTags);
    };

    // Handle input change
    const handleInputChange = (e: React.ChangeEvent<HTMLInputElement>) => {
      const newValue = e.target.value;
      setInputValue(newValue);

      // Clear error when user types
      if (inputError && newValue.trim()) {
        setInputError(null);
      }
    };

    // Handle key down (Enter to add)
    const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
      if (e.key === "Enter") {
        e.preventDefault();
        handleAddTag();
      }
    };

    // Check if field meets minimum requirements
    // const meetsMinRequirement = minTags === undefined || value.length >= minTags;
    const hasNoTags = value.length === 0;
    
    // Combine errors
    const displayError = error || inputError || (required && hasNoTags ? "At least one tag is required" : undefined);

    // Generate help text with constraints
    const generateHelpText = () => {
      let help = helpText || "";

      if (help) {
        help += " • ";
      }

      const parts: string[] = [];

      // Only add minTagLength if it's greater than 1 (default is 1)
      if (minTagLength > 1) {
        parts.push(`min ${minTagLength} chars`);
      }

      if (maxTagLength) {
        parts.push(`max ${maxTagLength} chars`);
      }

      if (maxTags) {
        parts.push(`max ${maxTags} tags`);
      }

      if (!allowDuplicates) {
        parts.push("no duplicates");
      }

      if (minTags && minTags > 0) {
        parts.push(`min ${minTags} required`);
      }

      if (parts.length > 0) {
        help += parts.join(", ");
      }

      // Always append default help text if we have constraints
      if (parts.length > 0) {
        help += " • Add tags and press Enter";
      }

      // Only show default help text if we have no custom help and no constraints
      if (!help && parts.length === 0) {
        return "Add tags and press Enter";
      }

      return help;
    };

    return (
      <FormField
        ref={ref}
        label={label}
        error={displayError}
        required={required}
        helpText={generateHelpText()}
        inputId={inputId}
        className={className}
      >
        <div className="space-y-2">
          {/* Tag chips */}
          <div className="flex flex-wrap gap-2 min-h-[40px]">
            {value.length === 0 ? (
              <span className="text-text-muted text-sm">{emptyText}</span>
            ) : (
              value.map((tag, index) => (
                <div
                  key={`${tag}-${index}`}
                  className={`
                    inline-flex items-center gap-1 px-3 py-1.5 rounded-full text-sm
                    bg-primary/10 text-primary border border-primary/20
                    ${tagClassName || ""}
                  `}
                >
                  <span>{tag}</span>
                  <button
                    type="button"
                    onClick={() => handleRemoveTag(index)}
                    className="hover:bg-primary/20 rounded-full p-0.5 transition-colors cursor-pointer"
                    aria-label={`Remove tag ${tag}`}
                  >
                    <svg
                      className="h-3 w-3"
                      fill="none"
                      stroke="currentColor"
                      viewBox="0 0 24 24"
                      aria-hidden="true"
                    >
                      <path
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        strokeWidth={2}
                        d="M6 18L18 6M6 6l12 12"
                      />
                    </svg>
                  </button>
                </div>
              ))
            )}
          </div>

          {/* Tag count */}
          {showCount && value.length > 0 && (
            <div className="text-xs text-text-muted">
              {value.length}{maxTags && `/${maxTags}`} {value.length === 1 ? 'tag' : 'tags'}
            </div>
          )}

          {/* Tag input */}
          <div className="relative">
            <input
              id={inputId}
              type="text"
              value={inputValue}
              onChange={handleInputChange}
              onKeyDown={handleKeyDown}
              placeholder={placeholder}
              className={`input w-full ${displayError ? "border-error" : ""}`}
              aria-invalid={displayError ? "true" : undefined}
              aria-describedby={displayError ? `${inputId}-error` : undefined}
              disabled={required && hasNoTags}
              {...props}
            />
          </div>
        </div>
      </FormField>
    );
  }
);

TagField.displayName = "TagField";
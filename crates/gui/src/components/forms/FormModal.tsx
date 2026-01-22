import { type ReactNode, type HTMLAttributes, forwardRef } from "react";

export interface FormModalProps extends HTMLAttributes<HTMLDivElement> {
  /**
   * Whether the modal is open/visible
   */
  isOpen: boolean;
  /**
   * The modal title text
   */
  title: string;
  /**
   * Content to display in the modal body
   */
  children: ReactNode;
  /**
   * Called when modal is closed (via Cancel button, backdrop click, or Escape key)
   */
  onClose: () => void;
  /**
   * Called when Submit button is clicked
   */
  onSubmit: () => void;
  /**
   * Whether the modal is currently submitting/loading
   */
  isSubmitting?: boolean;
  /**
   * Error message to display in the modal
   */
  error?: string;
  /**
   * Whether to disable the close button during submission
   */
  preventCloseDuringSubmit?: boolean;
  /**
   * Whether to prevent backdrop click during submission
   */
  preventBackdropClickDuringSubmit?: boolean;
  /**
   * Custom class names for the modal wrapper
   */
  className?: string;
  /**
   * Custom class names for the modal content
   */
  contentClassName?: string;
  /**
   * Custom class names for the modal header
   */
  headerClassName?: string;
  /**
   * Custom class names for the modal footer
   */
  footerClassName?: string;
  /**
   * Whether to show the close button (X) in the header
   */
  showCloseButton?: boolean;
  /**
   * Whether to show the cancel button
   */
  showCancelButton?: boolean;
  /**
   * Whether to show the submit button
   */
  showSubmitButton?: boolean;
  /**
   * Cancel button text (defaults to "Cancel")
   */
  cancelButtonText?: string;
  /**
   * Submit button text (defaults to "Submit")
   */
  submitButtonText?: string;
  /**
   * Whether to make the modal fullscreen
   */
  fullscreen?: boolean;
  /**
   * Whether the modal should trap focus within it when open
   */
  trapFocus?: boolean;
}

/**
 * FormModal wrapper component for consistent modal form styling.
 *
 * Provides:
 * - Modal overlay with backdrop click-to-close
 * - Header with title and close button (X)
 * - Body content area for form fields
 * - Footer with Cancel and Submit buttons
 * - Loading state management during submission
 * - Error banner display
 * - Keyboard navigation support (Escape to close)
 *
 * @example
 * ```tsx
 * <FormModal
 *   isOpen={isModalOpen}
 *   title="Edit Task"
 *   onClose={handleClose}
 *   onSubmit={handleSubmit}
 *   isSubmitting={isSubmitting}
 *   error={error}
 * >
 *   <form onSubmit={(e) => { e.preventDefault(); handleSubmit(); }}>
 *     <TextField label="Title" value={title} onChange={setTitle} required />
 *     <TextField label="Description" value={description} onChange={setDescription} />
 *   </form>
 * </FormModal>
 * ```
 */
export const FormModal = forwardRef<HTMLDivElement, FormModalProps>(
  (
    {
      isOpen,
      title,
      children,
      onClose,
      onSubmit,
      isSubmitting = false,
      error,
      preventCloseDuringSubmit = true,
      preventBackdropClickDuringSubmit = true,
      className = "",
      contentClassName = "",
      headerClassName = "",
      footerClassName = "",
      showCloseButton = true,
      showCancelButton = true,
      showSubmitButton = true,
      cancelButtonText = "Cancel",
      submitButtonText = "Submit",
      fullscreen = false,
      // trapFocus = false,
      ...props
    },
    ref
  ) => {
    // Handle backdrop click
    const handleBackdropClick = (e: React.MouseEvent) => {
      if (e.target === e.currentTarget) {
        // Only close if not submitting and backdrop click is not prevented
        if (!isSubmitting || !preventBackdropClickDuringSubmit) {
          onClose();
        }
      }
    };

    // Handle Escape key
    const handleKeyDown = (e: React.KeyboardEvent) => {
      if (e.key === "Escape") {
        // Only close if not submitting and close is not prevented
        if (!isSubmitting || !preventCloseDuringSubmit) {
          onClose();
        }
      }
    };

    // Handle submit button click
    const handleSubmitClick = (e: React.MouseEvent) => {
      e.preventDefault();
      onSubmit();
    };

    // Generate unique ID for accessibility
    const modalId = `modal-${Math.random().toString(36).slice(2, 9)}`;
    const titleId = `${modalId}-title`;

    if (!isOpen) {
      return null;
    }

    return (
      <div
        ref={ref}
        className={`fixed inset-0 z-50 flex items-center justify-center ${className}`}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-hidden={!isOpen}
        onClick={handleBackdropClick}
        onKeyDown={handleKeyDown}
        {...props}
      >
        {/* Backdrop */}
        <div className="fixed inset-0 bg-black/50 backdrop-blur-sm" />

        {/* Modal content */}
        <div
          className={`
            relative bg-background-secondary rounded-lg shadow-xl
            ${fullscreen ? 'inset-0 m-0 rounded-none' : 'm-4 max-w-2xl w-full max-h-[90vh] overflow-hidden'}
            ${contentClassName}
          `}
          role="document"
          tabIndex={-1}
        >
          {/* Header */}
          <div className={`flex items-center justify-between p-6 border-b border-border ${headerClassName}`}>
            <h2
              id={titleId}
              className="text-lg font-semibold text-text-primary"
            >
              {title}
            </h2>

            {/* Close button */}
            {showCloseButton && (
              <button
                type="button"
                onClick={onClose}
                disabled={isSubmitting && preventCloseDuringSubmit}
                className={`
                  p-1 rounded-md hover:bg-background-tertiary transition-colors
                  ${isSubmitting && preventCloseDuringSubmit ? 'opacity-50 cursor-not-allowed' : ''}
                `}
                aria-label="Close modal"
                disabled={isSubmitting && preventCloseDuringSubmit}
              >
                <svg
                  className="h-5 w-5 text-text-secondary"
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
            )}
          </div>

          {/* Error banner */}
          {error && (
            <div
              className="flex items-center gap-2 p-4 bg-error/10 border-b border-error"
              role="alert"
            >
              <svg
                className="h-5 w-5 text-error flex-shrink-0"
                fill="none"
                stroke="currentColor"
                viewBox="0 0 24 24"
                aria-hidden="true"
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={2}
                  d="M12 8v4m0 4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z"
                />
              </svg>
              <span className="text-sm text-error flex-grow">{error}</span>
              <button
                type="button"
                onClick={() => {}}
                className="p-1 hover:bg-error/20 rounded transition-colors"
                aria-label="Dismiss error"
              >
                <svg
                  className="h-4 w-4 text-error"
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
          )}

          {/* Body */}
          <div className="p-6 overflow-y-auto max-h-[calc(90vh-200px)]">
            {children}
          </div>

          {/* Footer */}
          <div className={`flex items-center justify-end gap-3 p-6 border-t border-border ${footerClassName}`}>
            {/* Cancel button */}
            {showCancelButton && (
              <button
                type="button"
                onClick={onClose}
                disabled={isSubmitting && preventCloseDuringSubmit}
                className={`
                  px-4 py-2 text-sm font-medium rounded-md border border-border
                  hover:bg-background-tertiary transition-colors
                  ${isSubmitting && preventCloseDuringSubmit ? 'opacity-50 cursor-not-allowed' : ''}
                `}
                disabled={isSubmitting && preventCloseDuringSubmit}
              >
                {cancelButtonText}
              </button>
            )}

            {/* Submit button */}
            {showSubmitButton && (
              <button
                type="button"
                onClick={handleSubmitClick}
                disabled={isSubmitting}
                className={`
                  px-4 py-2 text-sm font-medium rounded-md border border-transparent
                  ${isSubmitting
                    ? 'bg-primary/80 cursor-not-allowed'
                    : 'bg-primary hover:bg-primary/90 text-white'}
                  transition-colors flex items-center gap-2
                `}
                disabled={isSubmitting}
              >
                {isSubmitting && (
                  <svg
                    className="h-4 w-4 animate-spin"
                    fill="none"
                    stroke="currentColor"
                    viewBox="0 0 24 24"
                    aria-hidden="true"
                  >
                    <path
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      strokeWidth={2}
                      d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15"
                    />
                  </svg>
                )}
                {submitButtonText}
              </button>
            )}
          </div>
        </div>
      </div>
    );
  }
);

FormModal.displayName = "FormModal";
/**
 * Frontend-only types for UI state, component props, and app-specific structures.
 *
 * These types are not generated from the backend and exist only in the frontend
 * to support UI components and state management.
 */

import type { ReactNode } from 'react';

/**
 * Theme mode options for the application.
 * - 'light': Force light theme
 * - 'dark': Force dark theme
 * - 'system': Follow system preference
 */
export type ThemeMode = 'light' | 'dark' | 'system';

/**
 * Navigation item configuration for sidebar and menus.
 */
export interface NavItem {
  /** Display label for the navigation item */
  label: string;
  /** Route path to navigate to */
  path: string;
  /** Optional icon to display alongside the label */
  icon?: ReactNode;
  /** Whether this item is currently active */
  isActive?: boolean;
  /** Optional badge count (e.g., for notifications) */
  badge?: number;
}

/**
 * Generic loading state wrapper for async operations.
 * Use this to track the state of data fetching in components.
 *
 * @typeParam T - The type of data being loaded
 *
 * @example
 * ```typescript
 * const [taskState, setTaskState] = useState<LoadingState<Task>>({
 *   data: null,
 *   isLoading: true,
 *   error: null,
 * });
 * ```
 */
export interface LoadingState<T> {
  /** The loaded data, or null if not yet loaded or on error */
  data: T | null;
  /** Whether the data is currently being fetched */
  isLoading: boolean;
  /** Error message if the fetch failed, null otherwise */
  error: string | null;
}

/**
 * Option type for select/dropdown components.
 *
 * @typeParam T - The type of the option value (defaults to string)
 */
export interface SelectOption<T = string> {
  /** Display label shown to the user */
  label: string;
  /** The actual value when selected */
  value: T;
  /** Whether this option is disabled */
  disabled?: boolean;
}

/**
 * Common props for modal/dialog components.
 */
export interface ModalProps {
  /** Whether the modal is currently open */
  isOpen: boolean;
  /** Callback when the modal should close */
  onClose: () => void;
  /** Modal title displayed in the header */
  title?: string;
  /** Modal content */
  children?: ReactNode;
}

/**
 * Toast notification message type.
 */
export type ToastType = 'success' | 'error' | 'warning' | 'info';

/**
 * Toast notification message configuration.
 */
export interface ToastMessage {
  /** Unique identifier for the toast */
  id: string;
  /** Message to display */
  message: string;
  /** Type of toast (affects styling) */
  type: ToastType;
  /** Optional duration in milliseconds (default: 5000) */
  duration?: number;
}

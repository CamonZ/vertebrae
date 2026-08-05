/**
 * Frontend-only types for UI state, component props, and app-specific structures.
 *
 * These types are not generated from the backend and exist only in the frontend
 * to support UI components and state management.
 */

import type { ReactNode } from "react";
import type { Task } from "../bindings";

/**
 * Theme mode options for the application.
 * - 'light': Force light theme
 * - 'dark': Force dark theme
 * - 'system': Follow system preference
 */
export type ThemeMode = "light" | "dark" | "system";

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

/** Notification styling type shared by live task and step activity. */
export type ToastType = "success" | "error" | "warning" | "info";

/** Entities currently represented by the notifications panel. */
export type NotificationEntity = "task" | "step";

/** Input used when appending an ephemeral notification. */
export interface NotificationInput {
  message: string;
  type: ToastType;
  entity: NotificationEntity;
  entityId: string;
  timestamp?: number;
}

/** Ephemeral notification retained for the current application session. */
export interface NotificationMessage {
  /** Unique identifier for the notification */
  id: string;
  /** Message to display */
  message: string;
  /** Type of notification (affects styling) */
  type: ToastType;
  /** Entity family represented by the notification */
  entity: NotificationEntity;
  /** Source task or step identifier */
  entityId: string;
  /** Time at which the notification was received */
  timestamp: number;
  /** Whether the user has marked this notification as read */
  read: boolean;
}

/** @deprecated Use NotificationMessage for new UI state. */
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

/**
 * Frontend-only type for task tree nodes.
 * Used to build hierarchical task trees from flat task lists.
 */
export interface TaskTreeNode {
  /** The task data */
  task: Task;
  /** Whether this task has any blockers */
  has_blockers: boolean;
  /** Number of tasks blocking this one */
  blocker_count: number;
  /** Child task nodes */
  children: TaskTreeNode[];
}

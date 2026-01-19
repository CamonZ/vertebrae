/**
 * Central type exports for the Vertebrae GUI.
 *
 * This module re-exports generated types from Tauri bindings and provides
 * additional frontend-only types for UI state and utilities.
 *
 * @example
 * ```typescript
 * import type { Task, TaskStatus, LoadingState } from '@/types';
 * ```
 */

// Re-export generated types from Tauri bindings
export type {
  // Core task types
  Task,
  TaskSummary,
  TaskWithRelations,
  TaskHierarchyNode,
  TaskFilterOptions,

  // Task enums
  TaskLevel,
  TaskStatus,
  TaskPriority,

  // Task components
  Section,
  SectionType,
  CodeRef,

  // Workflow types
  Workflow,
  Step,
  WorkflowWithTasks,
  AgentConfig,
  PermissionMode,

  // API types
  CommandError,
  Result,
} from "../bindings";

// Re-export commands for convenient access
export { commands } from "../bindings";

// Frontend-only types
export type {
  ThemeMode,
  NavItem,
  LoadingState,
  SelectOption,
  ModalProps,
  ToastMessage,
  ToastType,
} from "./ui";

// Utility types
export type {
  DeepPartial,
  Nullable,
  Optional,
  RequiredFields,
  PickByType,
  OmitByType,
  AsyncReturnType,
  UnwrapResult,
} from "./utils";

/**
 * Central type exports for the Vertebrae GUI.
 *
 * This module re-exports generated types from Tauri bindings and provides
 * additional frontend-only types for UI state and utilities.
 *
 * @example
 * ```typescript
 * import type { Task, TaskLevel, LoadingState } from '@/types';
 * ```
 */

// Re-export generated types from Tauri bindings
export type {
  // Core task types
  Task,
  TaskFilterOptions,

  // Task enums
  TaskLevel,
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

  // TaskRun types
  TaskRun,
  TaskRunControls,
  TaskRunStatus,
  TaskRunTrace,
  StopRunRequest,
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
  NotificationEntity,
  NotificationInput,
  NotificationMessage,
  ToastMessage,
  ToastType,
  TaskTreeNode,
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

// Conversation log types
export type {
  ConversationEvent,
  SessionStartEvent,
  SessionEndEvent,
  ThinkingEvent,
  ToolCallEvent,
  ToolResultEvent,
} from "./conversation";

export { parseSessionLogs, getToolIcon } from "./conversation";
